import { and, eq, lte } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { fxRates, pricingRules } from '../../db/schema.js'
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { outboundFetch } from '../outbound/client.js'
import { writeAudit } from '../audit/service.js'
import type { ProviderBillingOption } from '../providers/provider.interface.js'
import { exactProviderCents, scaledDecimal } from './periods.js'
import { getConfig } from '../../config.js'
import { z } from 'zod'

type FxRate = { rate: string; from: string; to: string; createdAt: Date; id?: number; source?: string }
const usdtRefreshes = new WeakMap<DbClient, Promise<FxRate>>()
/** Market USDT expires at the configured TTL; operator-set non-USDT rates last 24h. */
export const fxMaxAgeMs = (currency: string) => (['USD', 'USDT'].includes(currency) ? getConfig().USDT_RATE_MAX_AGE_SECONDS : 86400) * 1000
const usdtTicker = z.object({
  data: z.object({ markets: z.object({ USDTIRT: z.object({
    symbol: z.literal('USDT'),
    active: z.literal(true),
    buy_price: z.string().regex(/^\d+(?:\.\d{1,8})?$/),
  }) }) }),
})


// ---------------------------------------------------------------------------
// FX rates (history rows; the latest per pair is active)
// ---------------------------------------------------------------------------
export async function getActiveFxRate(db: DbClient, currency = 'EUR'): Promise<FxRate> {
  if (currency === 'IRR') return { rate: '1', from: 'IRR', to: 'IRR', createdAt: new Date() }
  const canonicalCurrency = currency === 'USD' ? 'USDT' : currency
  const row = await db.query.fxRates.findFirst({
    where: (t) => and(eq(t.fromCurrency, canonicalCurrency), eq(t.toCurrency, 'IRR'), lte(t.createdAt, new Date())),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
  })
  if (canonicalCurrency === 'USDT' && (!row || Date.now() - row.createdAt.getTime() >= getConfig().USDT_RATE_MAX_AGE_SECONDS * 1000)) {
    let refresh = usdtRefreshes.get(db)
    if (!refresh) {
      refresh = refreshUsdtRate(db).finally(() => usdtRefreshes.delete(db))
      usdtRefreshes.set(db, refresh)
    }
    return refresh
  }
  if (!row) {
    throw new NotFoundError(
      `نرخ ارز ${currency} به IRR تنظیم نشده است؛ ادمین باید نرخ این ارز را ثبت کند.`,
    )
  }
  if (Date.now() - row.createdAt.getTime() >= fxMaxAgeMs(currency)) throw new AppError(503, 'fx_rate_stale', 'نرخ معتبر ارز در دسترس نیست؛ نرخ تازه لازم است')
  return { rate: row.rate, from: row.fromCurrency, to: row.toCurrency, createdAt: row.createdAt, id: row.id, source: row.note ?? (row.setBy ? 'operator-approved' : 'stored FX history') }
}

export async function setFxRate(db: DbClient, rate: string, opts: { actorId?: string | null; note?: string; currency?: string; source?: 'market' } = {}) {
  const numeric = Number(rate)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ValidationError('نرخ ارز باید عددی مثبت باشد')
  }
  const currency = opts.currency === 'USD' ? 'USDT' : opts.currency ?? 'EUR'
  const [row] = await db
    .insert(fxRates)
    .values({ fromCurrency: currency, toCurrency: 'IRR', rate, setBy: opts.actorId ?? null, note: opts.note ?? null, createdAt: new Date() })
    .returning()
  if (!row) throw new Error('failed to set fx rate')
  await writeAudit(db, {
    actorId: opts.actorId ?? null,
    action: opts.source === 'market' ? 'pricing.fx_rate.refreshed' : 'admin.fx_rate.changed',
    metadata: { rate, from: currency, to: 'IRR' },
  })
  return row
}

export async function listFxRateHistory(db: DbClient, limit = 20, currency = 'EUR') {
  const canonicalCurrency = currency === 'USD' ? 'USDT' : currency
  return db.query.fxRates.findMany({
    where: (t) => and(eq(t.fromCurrency, canonicalCurrency), eq(t.toCurrency, 'IRR')),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
    limit,
  })
}

async function refreshUsdtRate(db: DbClient): Promise<FxRate> {
  let rate: string
  try {
    const url = new URL('/api/v1/manager/otc/ticker', getConfig().USDT_RATE_API_BASE_URL)
    url.searchParams.set('coin', 'USDT')
    const response = await outboundFetch('abantether', url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`USDT ticker HTTP ${response.status}`)
    const ticker = usdtTicker.parse(await response.json())
    const [whole, fraction = ''] = ticker.data.markets.USDTIRT.buy_price.split('.')
    const tomanScaled = BigInt(whole!) * 100000000n + BigInt(fraction.padEnd(8, '0'))
    // IRT -> IRR (x10); round upwards only beyond the ledger's six FX decimals.
    const rialMicros = (tomanScaled + 9n) / 10n
    if (rialMicros <= 0n || rialMicros >= 100000000000000000000n) throw new Error('USDT rate is outside ledger precision')
    rate = `${rialMicros / 1000000n}.${(rialMicros % 1000000n).toString().padStart(6, '0')}`
  } catch {
    throw new AppError(503, 'usdt_rate_unavailable', 'نرخ معتبر تتر به ریال در دسترس نیست؛ قیمت‌گذاری دلاری تا دریافت نرخ تازه متوقف است.')
  }
  const row = await setFxRate(db, rate, { currency: 'USDT', source: 'market', note: 'AbanTether USDTIRT buy_price (toman × 10); USD = USDT' })
  return { rate: row.rate, from: row.fromCurrency, to: row.toCurrency, createdAt: row.createdAt, id: row.id, source: row.note ?? (row.setBy ? 'operator-approved' : 'stored FX history') }
}

// ---------------------------------------------------------------------------
// Pricing rules (per provider)
// ---------------------------------------------------------------------------
export async function getPricingRules(db: DbClient, provider = 'leaseweb') {
  const existing = await db.query.pricingRules.findFirst({ where: (t) => eq(t.provider, provider) })
  if (existing) return existing
  const [created] = await db
    .insert(pricingRules)
    .values({ provider, markupPercent: String(getConfig().STOREFRONT_PRICING[provider]?.markupPercent ?? 25), markupFixedRial: 0, taxPercent: '0', roundingToRial: 1000 })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const concurrent = await db.query.pricingRules.findFirst({ where: (t) => eq(t.provider, provider) })
  if (!concurrent) throw new Error('failed to load pricing rules')
  return concurrent
}

export async function updatePricingRules(
  db: DbClient,
  provider: string,
  input: { markupPercent?: number; markupFixedRial?: number; taxPercent?: number; roundingToRial?: number; enabled?: boolean },
  actorId?: string,
) {
  const rules = await getPricingRules(db, provider)
  const next: Record<string, unknown> = {}
  if (input.markupPercent !== undefined) next.markupPercent = String(input.markupPercent)
  if (input.markupFixedRial !== undefined) next.markupFixedRial = input.markupFixedRial
  if (input.taxPercent !== undefined) next.taxPercent = String(input.taxPercent)
  if (input.roundingToRial !== undefined) next.roundingToRial = input.roundingToRial
  if (input.enabled !== undefined) next.enabled = input.enabled
  next.updatedBy = actorId ?? null
  next.updatedAt = new Date()
  await db.update(pricingRules).set(next).where(eq(pricingRules.id, rules.id))
  await writeAudit(db, {
    actorId: actorId ?? null,
    action: 'admin.price_rule.changed',
    targetType: 'pricing_rules',
    targetId: rules.id,
    metadata: { provider, changes: input },
  })
  return getPricingRules(db, provider)
}

// ---------------------------------------------------------------------------
// Price engine — produces a full snapshot. All integer math.
// ---------------------------------------------------------------------------
export interface PriceSnapshot {
  providerCurrency: string
  providerAmountCents: number
  fxRate: string
  markupPercent: string
  markupFixedRial: number
  taxPercent: string
  subtotalRial: number
  taxRial: number
  totalRial: number
  fxRateId?: number
  fxAt?: string
  fxSource?: string
}

export interface PricingRuleValues {
  markupPercent: string
  markupFixedRial: number
  taxPercent: string
  roundingToRial: number
  enabled: boolean
}

/**
 * Pure price engine — no DB access, unit-testable. All integer math.
 * providerAmountCents * fxRate / 100 -> rials, then markup + tax + rounding.
 */
export function computePriceFromRules(input: {
  providerCurrency: string
  providerAmountCents: number
  fxRate: string
  rules: PricingRuleValues
}): PriceSnapshot {
  const { rules } = input
  if (!rules.enabled) throw new ValidationError('قیمت‌گذاری این سرویس‌دهنده غیرفعال است')
  if (!Number.isFinite(input.providerAmountCents) || input.providerAmountCents <= 0) {
    throw new ValidationError('محصول انتخابی قیمت معتبری ندارد')
  }

  if (!Number.isSafeInteger(rules.markupFixedRial) || rules.markupFixedRial < 0) throw new ValidationError('قاعده قیمت نامعتبر است')
  const cost = scaledDecimal(String(input.providerAmountCents), 6) * scaledDecimal(input.fxRate, 6)
  const denominator = 100_000_000_000_000n
  const percentScale = 1_000_000n // four percentage decimals / 100
  const subtotalNumerator = (cost + BigInt(rules.markupFixedRial) * denominator) * (percentScale + scaledDecimal(rules.markupPercent, 4))
  const subtotal = Number(subtotalNumerator / (denominator * percentScale))
  // One deterministic downward conversion at the ledger's single IRR boundary.
  // Preserve fractional provider cents and markup until this final calculation.
  const exactTotal = subtotalNumerator * (percentScale + scaledDecimal(rules.taxPercent, 4)) / (denominator * percentScale * percentScale)
  if (exactTotal <= 0n || exactTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError('مبلغ محاسبه‌شده خارج از دقت دفترکل است')
  const total = Number(exactTotal)
  const tax = total - subtotal

  return {
    providerCurrency: input.providerCurrency,
    providerAmountCents: input.providerAmountCents,
    fxRate: input.fxRate,
    markupPercent: rules.markupPercent,
    markupFixedRial: rules.markupFixedRial,
    taxPercent: rules.taxPercent,
    subtotalRial: subtotal,
    taxRial: tax,
    totalRial: total,
  }
}

export async function computePriceSnapshot(
  db: DbClient,
  input: {
    provider: string
    providerCurrency: string
    billingOption: ProviderBillingOption
    fxRate?: string
  },
): Promise<PriceSnapshot> {
  const rules = await getPricingRules(db, input.provider)
  const fx = input.fxRate && input.providerCurrency !== 'USD' && input.providerCurrency !== 'USDT'
    ? { rate: input.fxRate }
    : await getActiveFxRate(db, input.providerCurrency)
  const providerAmountCents = exactProviderCents(input.billingOption)
  return { ...computePriceFromRules({
    providerCurrency: input.providerCurrency,
    providerAmountCents,
    fxRate: fx.rate,
    rules: {
      markupPercent: rules.markupPercent,
      markupFixedRial: rules.markupFixedRial,
      taxPercent: rules.taxPercent,
      roundingToRial: rules.roundingToRial,
      enabled: rules.enabled,
    },
  }), fxAt: 'createdAt' in fx ? (fx.createdAt as Date).toISOString() : new Date().toISOString(), fxRateId: 'id' in fx ? fx.id : undefined, fxSource: 'source' in fx ? fx.source : 'explicit quote FX' }
}
