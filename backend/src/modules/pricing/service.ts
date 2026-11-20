import { and, eq, lte } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { pricingRules } from '../../db/schema.js'
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import type { ProviderBillingOption } from '../providers/provider.interface.js'
import { exactProviderCents, scaledDecimal } from './periods.js'
import { getConfig } from '../../config.js'

import { fxMaxAgeMs, getMarketRate, type FxRate } from './market-fx.js'
export { euroMarketSource, euroRefreshIntervalMs, fxMaxAgeMs, refreshEuroRate } from './market-fx.js'
export { saveFxRate as setFxRate } from './rate-history.js'

export async function getActiveFxRate(db: DbClient, currency = 'EUR'): Promise<FxRate> {
  if (currency === 'IRR') return { rate: '1', from: 'IRR', to: 'IRR', createdAt: new Date() }
  if (currency === 'EUR') return getMarketRate(db, 'EUR')
  if (currency === 'USD' || currency === 'USDT') return getMarketRate(db, 'USDT')
  const row = await db.query.fxRates.findFirst({
    where: t => and(eq(t.fromCurrency, currency), eq(t.toCurrency, 'IRR'), lte(t.createdAt, new Date())),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
  })
  if (!row) throw new NotFoundError(`نرخ ارز ${currency} به IRR تنظیم نشده است`)
  if (Date.now() - row.createdAt.getTime() >= fxMaxAgeMs(currency)) throw new AppError(503, 'fx_rate_stale', 'نرخ معتبر ارز در دسترس نیست؛ نرخ تازه لازم است')
  return { rate: row.rate, from: row.fromCurrency, to: row.toCurrency, createdAt: row.createdAt, id: row.id, source: row.note ?? 'operator-approved' }
}

export async function listFxRateHistory(db: DbClient, limit = 20, currency = 'EUR') {
  const canonicalCurrency = currency === 'USD' ? 'USDT' : currency
  return db.query.fxRates.findMany({
    where: (t) => and(eq(t.fromCurrency, canonicalCurrency), eq(t.toCurrency, 'IRR')),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
    limit,
  })
}

// ---------------------------------------------------------------------------
// Pricing rules (per provider)
// ---------------------------------------------------------------------------
export async function getPricingRules(db: DbOrTx, provider = 'leaseweb') {
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

export type PricingRuleEdit = { markupPercent?: number | string; markupFixedRial?: number; taxPercent?: number; roundingToRial?: number; enabled?: boolean }

export async function updatePricingRules(
  db: DbClient,
  provider: string,
  input: PricingRuleEdit,
  actorId?: string,
) {
  return db.transaction(tx => savePricingRules(tx, provider, input, actorId))
}

export async function savePricingRules(tx: DbOrTx, provider: string, input: PricingRuleEdit, actorId?: string, version?: string) {
  const initial = await getPricingRules(tx, provider)
  const [rules] = await tx.select().from(pricingRules).where(eq(pricingRules.id, initial.id)).for('update')
  if (!rules) throw new NotFoundError('قاعدهٔ قیمت‌گذاری یافت نشد.')
  if (version !== undefined && version !== rules.updatedAt.toISOString()) throw new ConflictError('تعرفه تغییر کرده است. تنظیمات را تازه کنید.')
  const next: Partial<typeof pricingRules.$inferInsert> = {}
  if (input.markupPercent !== undefined) next.markupPercent = String(input.markupPercent)
  if (input.markupFixedRial !== undefined) next.markupFixedRial = input.markupFixedRial
  if (input.taxPercent !== undefined) next.taxPercent = String(input.taxPercent)
  if (input.roundingToRial !== undefined) next.roundingToRial = input.roundingToRial
  if (input.enabled !== undefined) next.enabled = input.enabled
  next.updatedBy = actorId ?? null
  next.updatedAt = new Date(Math.max(Date.now(), rules.updatedAt.getTime() + 1))
  const [saved] = await tx.update(pricingRules).set(next).where(eq(pricingRules.id, rules.id)).returning()
  if (!saved) throw new NotFoundError('قاعدهٔ قیمت‌گذاری یافت نشد.')
  await writeAudit(tx, {
    actorId: actorId ?? null,
    action: 'admin.price_rule.changed',
    targetType: 'pricing_rules',
    targetId: rules.id,
    metadata: { provider, changes: input, before: rules, after: saved },
  })
  return saved
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
  ruleVersion?: string
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
  units?: { numerator: number; denominator: number }
}): PriceSnapshot {
  const { rules } = input
  if (!rules.enabled) throw new ValidationError('قیمت‌گذاری این سرویس‌دهنده غیرفعال است')
  if (!Number.isFinite(input.providerAmountCents) || input.providerAmountCents <= 0) {
    throw new ValidationError('محصول انتخابی قیمت معتبری ندارد')
  }

  if (!Number.isSafeInteger(rules.markupFixedRial) || rules.markupFixedRial < 0) throw new ValidationError('قاعده قیمت نامعتبر است')
  const units = input.units ?? { numerator: 1, denominator: 1 }
  if (![units.numerator, units.denominator].every(value => Number.isSafeInteger(value) && value > 0)) throw new ValidationError('تعداد واحد قیمت نامعتبر است')
  const cost = scaledDecimal(String(input.providerAmountCents), 6) * scaledDecimal(input.fxRate, 6) * BigInt(units.numerator)
  const denominator = 100_000_000_000_000n * BigInt(units.denominator)
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
  }), ruleVersion: rules.updatedAt.toISOString(), fxAt: 'createdAt' in fx ? (fx.createdAt as Date).toISOString() : new Date().toISOString(), fxRateId: 'id' in fx ? fx.id : undefined, fxSource: 'source' in fx ? fx.source : 'explicit quote FX' }
}
