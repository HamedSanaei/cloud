import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DbClient } from '../../db/index.js'
import type { SessionUser } from '../auth/service.js'
import { AppError, ConflictError, ForbiddenError } from '../../lib/errors.js'
import { isSiteAuthority } from '../integration/authority.js'
import { getStorefront } from '../catalog/storefront.js'
import { consumeAuthorization, isPricingSuperAdmin } from '../system/security.js'
import { computePriceFromRules, getPricingRules, savePricingRules } from './service.js'
import { providerCentsToRial } from './periods.js'
import { maxHetznerFixedRial, maxHetznerMarkupPercent } from '../../contracts/hetzner-margin.js'

export const marginAction = 'pricing.hetzner_margin'
export const marginInput = z.object({
  markupPercent: z.string().regex(/^\d{1,4}(?:\.\d{1,4})?$/).refine(value => Number(value) <= maxHetznerMarkupPercent),
  markupFixedRial: z.number().int().min(0).max(maxHetznerFixedRial),
  version: z.iso.datetime(),
}).strict()
export const confirmedMargin = marginInput.extend({ confirm: z.literal(true) })
type MarginInput = z.infer<typeof marginInput>

export function requireHetznerPricingAdmin(user: SessionUser) {
  if (!isSiteAuthority() || !isPricingSuperAdmin(user)) throw new ForbiddenError('تنظیم سود هتزنر فقط برای سوپرادمین سایت مجاز است.')
}

export async function getHetznerMargin(db: DbClient) {
  const rule = await getPricingRules(db, 'hetzner')
  const history = await db.query.auditLogs.findMany({
    where: t => and(eq(t.targetId, rule.id), eq(t.action, 'admin.price_rule.changed')),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
    columns: { id: true, actorId: true, createdAt: true, metadata: true },
    limit: 20,
  })
  return { markupPercent: rule.markupPercent, markupFixedRial: rule.markupFixedRial, taxPercent: rule.taxPercent,
    enabled: rule.enabled, version: rule.updatedAt.toISOString(), updatedBy: rule.updatedBy,
    history: history.map(({ id, actorId, createdAt, metadata }) => {
      type AuditMargin = { markupPercent: string; markupFixedRial: number; updatedAt: string }
      const { before, after } = (metadata ?? {}) as { before?: AuditMargin; after?: AuditMargin }
      const project = (value: AuditMargin | undefined) => value ? {
        markupPercent: value.markupPercent, markupFixedRial: value.markupFixedRial, updatedAt: value.updatedAt,
      } : null
      return { id, actorId, createdAt: createdAt.toISOString(), before: project(before), after: project(after) }
    }),
  }
}

export async function previewHetznerMargin(db: DbClient, input: MarginInput) {
  const current = await getPricingRules(db, 'hetzner')
  if (input.version !== current.updatedAt.toISOString()) throw new ConflictError('تعرفه تغییر کرده است. تنظیمات را تازه کنید.')
  const samples = new Map<string, { id: string; name: string; location: string; prices: Array<{
    period: string; providerCurrency: string; providerAmountCents: number; providerRial: number; fxRate: string; fxAt: string
    beforeRial: number | null; afterRial: number; markupRial: number; effectivePercent: number | null; taxRial: number
  }> }>()
  try {
    await getStorefront(db, false, 'hetzner', (offer, period, cost, fxAt) => {
      if (cost.rules.updatedAt.toISOString() !== input.version) {
        throw new ConflictError('تعرفه تغییر کرده است. تنظیمات را تازه کنید.')
      }
      const after = computePriceFromRules({ ...cost, rules: { ...cost.rules, markupPercent: input.markupPercent, markupFixedRial: input.markupFixedRial } })
      const providerRial = providerCentsToRial(cost.providerAmountCents, cost.fxRate)
      const markupRial = after.subtotalRial - providerRial
      let beforeRial: number | null = null
      try { beforeRial = computePriceFromRules(cost).totalRial } catch (error) {
        if (!(error instanceof AppError) || error.status !== 422) throw error
      }
      const sample = samples.get(offer.id) ?? { ...offer, prices: [] }
      sample.prices.push({ period, providerCurrency: cost.providerCurrency, providerAmountCents: cost.providerAmountCents,
        providerRial, fxRate: cost.fxRate, fxAt: fxAt.toISOString(), beforeRial, afterRial: after.totalRial, markupRial,
        effectivePercent: providerRial ? markupRial / providerRial * 100 : null, taxRial: after.taxRial })
      samples.set(offer.id, sample)
    })
  } catch (error) {
    if (error instanceof AppError && ['not_found', 'fx_rate_stale', 'eur_rate_unavailable', 'usdt_rate_unavailable'].includes(error.code)) {
      throw new AppError(503, 'margin_fx_unavailable', 'پیش‌نمایش به نرخ ارز معتبر نیاز دارد. پس از تازه‌شدن نرخ دوباره تلاش کنید.')
    }
    throw error
  }
  // Validate the full catalog, then show a small sample across locations.
  const sorted = [...samples.values()].sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const locations = new Set<string>()
  const representatives = sorted.filter(offer => {
    if (locations.has(offer.location)) return false
    locations.add(offer.location)
    return true
  })
  return [...representatives, ...sorted.filter(offer => !representatives.includes(offer))].slice(0, 8)
}

export async function updateHetznerMargin(db: DbClient, user: SessionUser, input: z.infer<typeof confirmedMargin>, proof: string) {
  requireHetznerPricingAdmin(user)
  await previewHetznerMargin(db, input)
  await db.transaction(async tx => {
    await consumeAuthorization(tx, user, proof, marginAction, input)
    await savePricingRules(tx, 'hetzner', { markupPercent: input.markupPercent, markupFixedRial: input.markupFixedRial }, user.id, input.version)
  })
}
