import { z } from 'zod'
import type { IndicativeTrafficTariff } from '../../contracts/home-tariffs.js'
import { ValidationError } from '../../lib/errors.js'
import { exactProviderCents } from './periods.js'
import { computePriceFromRules, type PricingRuleValues } from './service.js'

const evidence = z.object({
  source: z.literal('hetzner-server-type-location'),
  location: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  grossPerTb: z.string().regex(/^\d{1,7}(?:\.\d{1,8})?$/),
  includedTrafficBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export function indicativeHetznerTraffic(
  product: { provider: string; providerCurrency: string; raw: unknown; lastSyncedAt: Date },
  location: string,
  rules: PricingRuleValues & { updatedAt: Date },
  fx: { rate: string; createdAt: Date },
): IndicativeTrafficTariff | null {
  if (product.provider !== 'hetzner') return null
  const result = evidence.safeParse((product.raw as { trafficTariff?: unknown } | null)?.trafficTariff)
  if (!result.success || result.data.location !== location || result.data.currency !== product.providerCurrency) return null
  const data = result.data
  try {
    const price = computePriceFromRules({
      providerCurrency: data.currency,
      providerAmountCents: exactProviderCents({ billingCycle: 'per-tb', amount: data.grossPerTb }),
      fxRate: fx.rate,
      // The fixed component is a per-period server markup. The traffic
      // indication uses the configured percentages and the same IRR boundary.
      rules: { ...rules, markupFixedRial: 0 },
    })
    return { perTbRial: price.totalRial, includedBytes: data.includedTrafficBytes, source: data.source,
      observedAt: product.lastSyncedAt.toISOString(), fxAt: fx.createdAt.toISOString(), ruleVersion: rules.updatedAt.toISOString() }
  } catch (error) {
    if (error instanceof ValidationError) return null
    throw error
  }
}
