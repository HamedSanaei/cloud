import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { fxRates, pricingRules } from '../../db/schema.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { percentOf, roundTo } from '../../lib/money.js'
import { writeAudit } from '../audit/service.js'
import type { ProviderBillingOption } from '../providers/provider.interface.js'
import { exactProviderCents, providerCentsToRial } from './periods.js'
import { getConfig } from '../../config.js'


// ---------------------------------------------------------------------------
// FX rates (history rows; the latest per pair is active)
// ---------------------------------------------------------------------------
export async function getActiveFxRate(db: DbClient, currency = 'EUR'): Promise<{ rate: string; from: string; to: string; createdAt: Date }> {
  if (currency === 'IRR') return { rate: '1', from: 'IRR', to: 'IRR', createdAt: new Date() }
  const row = await db.query.fxRates.findFirst({
    where: (t) => and(eq(t.fromCurrency, currency), eq(t.toCurrency, 'IRR')),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  })
  if (!row) {
    throw new NotFoundError(
      `نرخ ارز ${currency} به IRR تنظیم نشده است؛ ادمین باید نرخ این ارز را ثبت کند.`,
    )
  }
  return { rate: row.rate, from: row.fromCurrency, to: row.toCurrency, createdAt: row.createdAt }
}

export async function setFxRate(db: DbClient, rate: string, opts: { actorId?: string | null; note?: string; currency?: string } = {}) {
  const numeric = Number(rate)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ValidationError('نرخ ارز باید عددی مثبت باشد')
  }
  const [row] = await db
    .insert(fxRates)
    .values({ fromCurrency: opts.currency ?? 'EUR', toCurrency: 'IRR', rate, setBy: opts.actorId ?? null, note: opts.note ?? null })
    .returning()
  if (!row) throw new Error('failed to set fx rate')
  await writeAudit(db, {
    actorId: opts.actorId ?? null,
    action: 'admin.fx_rate.changed',
    metadata: { rate, from: opts.currency ?? 'EUR', to: 'IRR' },
  })
  return row
}

export async function listFxRateHistory(db: DbClient, limit = 20, currency = 'EUR') {
  return db.query.fxRates.findMany({
    where: (t) => and(eq(t.fromCurrency, currency), eq(t.toCurrency, 'IRR')),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
  })
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

  const providerRial = providerCentsToRial(input.providerAmountCents, input.fxRate)
  const base = providerRial + rules.markupFixedRial
  const subtotal = base + percentOf(base, rules.markupPercent)
  const tax = percentOf(subtotal, rules.taxPercent)
  const total = roundTo(subtotal + tax, rules.roundingToRial)

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
  const fx = input.fxRate ? { rate: input.fxRate } : await getActiveFxRate(db, input.providerCurrency)
  const providerAmountCents = exactProviderCents(input.billingOption)
  return computePriceFromRules({
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
  })
}