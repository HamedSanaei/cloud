import { z } from 'zod'
import { isTrafficByteCount, type IndicativeTrafficTariff } from '../../contracts/home-tariffs.js'
import { ValidationError } from '../../lib/errors.js'
import { exactProviderCents } from './periods.js'
import { computePriceFromRules, type PricingRuleValues } from './service.js'

const evidence = z.object({
  source: z.literal('hetzner-server-type-location'),
  location: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  grossPerTb: z.string().regex(/^\d{1,7}(?:\.\d{1,8})?$/),
})
type TrafficProduct = { provider: string; providerCurrency: string; raw: unknown }
type TrafficData = { includedTrafficBytes?: unknown; trafficTariff?: { source?: unknown; location?: unknown; currency?: unknown; includedTrafficBytes?: unknown } }

export function hetznerTrafficTariff(product: TrafficProduct, location: string) {
  if (product.provider !== 'hetzner') return null
  const result = evidence.safeParse((product.raw as TrafficData | null)?.trafficTariff)
  return result.success && result.data.location === location && result.data.currency === product.providerCurrency ? result.data : null
}

export function hetznerIncludedTraffic(product: TrafficProduct, location: string): number | null {
  if (product.provider !== 'hetzner') return null
  const raw = product.raw as TrafficData | null
  if (isTrafficByteCount(raw?.includedTrafficBytes)) return raw.includedTrafficBytes
  const legacy = raw?.trafficTariff
  return legacy?.source === 'hetzner-server-type-location' && legacy.location === location &&
    legacy.currency === product.providerCurrency && isTrafficByteCount(legacy.includedTrafficBytes) ? legacy.includedTrafficBytes : null
}

export function indicativeHetznerTraffic(
  product: TrafficProduct & { lastSyncedAt: Date },
  location: string,
  rules: PricingRuleValues & { updatedAt: Date },
  fx: { rate: string; createdAt: Date },
): IndicativeTrafficTariff | null {
  const data = hetznerTrafficTariff(product, location)
  if (!data) return null
  try {
    const price = computePriceFromRules({
      providerCurrency: data.currency,
      providerAmountCents: exactProviderCents({ billingCycle: 'per-tb', amount: data.grossPerTb }),
      fxRate: fx.rate,
      // The fixed component is a per-period server markup. The traffic
      // indication uses the configured percentages and the same IRR boundary.
      rules: { ...rules, markupFixedRial: 0 },
    })
    return { perTbRial: price.totalRial, includedBytes: hetznerIncludedTraffic(product, location), source: data.source,
      observedAt: product.lastSyncedAt.toISOString(), fxAt: fx.createdAt.toISOString(), ruleVersion: rules.updatedAt.toISOString() }
  } catch (error) {
    if (error instanceof ValidationError) return null
    throw error
  }
}
