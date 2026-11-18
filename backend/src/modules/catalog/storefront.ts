import { eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { getConfig } from '../../config.js'
import { ValidationError } from '../../lib/errors.js'
import { computePriceFromRules, fxMaxAgeMs, getActiveFxRate, getPricingRules } from '../pricing/service.js'
import { offeredPeriods, retailBilling, type RetailPeriod } from '../pricing/periods.js'
import type { ProviderBillingOption, ProviderOsOption } from '../providers/provider.interface.js'
import { listProviders } from '../providers/registry.js'
import { hetznerIncludedTraffic, indicativeHetznerTraffic } from '../pricing/hetzner-traffic.js'
import type { IndicativeTrafficTariff } from '../../contracts/home-tariffs.js'

interface StorefrontPrice {
  period: RetailPeriod
  totalRial: number
  billingCycle: string
  contractTerm?: string | number
}


interface StorefrontOffer {
  id: string
  provider: string
  location: string
  country?: string | null
  city?: string | null
  name: string
  category: string
  vcpu: number
  memoryMb: number
  diskGb: number
  diskType?: string
  trafficGb: number | null
  includedTrafficBytes?: number | null
  trafficOverage?: IndicativeTrafficTariff | null
  operatingSystems: ProviderOsOption[]
  prices: StorefrontPrice[]
}
type RetailCost = Parameters<typeof computePriceFromRules>[0] & { rules: Awaited<ReturnType<typeof getPricingRules>> }
type ObserveRetailCost = (offer: { id: string; name: string; location: string }, period: RetailPeriod, cost: RetailCost, fxAt: Date) => void

// The observer is server-only. The returned storefront always contains retail prices.
export async function getStorefront(db: DbClient, admin = false, providerFilter?: string, observeCost?: ObserveRetailCost) {
  const config = getConfig()
  const registered = new Set(listProviders().map((provider) => provider.id))
  const configured = [
    { id: 'hetzner', ...config.PROVIDERS.hetzner },
    { id: 'leaseweb', ...config.PROVIDERS.leaseweb },
  ].filter((provider) => provider.enabled && provider.orderingEnabled && registered.has(provider.id) && (!providerFilter || providerFilter === provider.id))
  const providerRows = await db.query.providers.findMany({ where: admin ? undefined : (t) => eq(t.enabled, true) })
  const active = configured.filter((provider) => providerRows.some((row) => row.id === provider.id && row.mode === 'live'))
  const activeIds = new Set(active.map((provider) => provider.id))
  const [products, locations] = await Promise.all([
    db.query.providerProducts.findMany({ where: (t, { and }) => and(eq(t.available, true), eq(t.enabled, true)) }),
    db.query.providerLocations.findMany({ where: (t) => eq(t.available, true) }),
  ])
  const locationById = new Map(locations.map((location) => [location.id, location]))
  const maxAgeMs = config.CATALOG_MAX_AGE_MINUTES * 60_000
  const eligible = products.filter(product => activeIds.has(product.provider) && locationById.has(product.locationId ?? '') &&
    (maxAgeMs <= 0 || Date.now() - product.lastSyncedAt.getTime() <= maxAgeMs) && (product.operatingSystems as ProviderOsOption[] | null)?.length)
  const pricingKeys = [...new Set(eligible.map((product) => product.provider === 'leaseweb' && product.category === 'cloud' ? 'leaseweb.hourly' : product.provider))]
  const rulesByProvider = new Map(await Promise.all(pricingKeys.map(async (key) => [key, await getPricingRules(db, key)] as const)))
  const currencies = [...new Set(eligible.map((product) => product.providerCurrency))]
  const fxByCurrency = new Map(await Promise.all(currencies.map(async (currency) => [currency, await getActiveFxRate(db, currency)] as const)))
  const offers: StorefrontOffer[] = []
  for (const product of eligible) {
    const location = locationById.get(product.locationId ?? '')
    const rules = rulesByProvider.get(product.provider === 'leaseweb' && product.category === 'cloud' ? 'leaseweb.hourly' : product.provider)
    const fx = fxByCurrency.get(product.providerCurrency)
    if (!location || !rules?.enabled || !fx) continue
    const options = (product.billingOptions ?? []) as ProviderBillingOption[]
    const operatingSystems = (product.operatingSystems ?? []) as ProviderOsOption[]
    if (operatingSystems.length === 0) continue
    const prices: StorefrontPrice[] = []
    for (const period of offeredPeriods(options)) {
      let billing: ReturnType<typeof retailBilling>
      try { billing = retailBilling(options, period) } catch (error) {
        if (error instanceof ValidationError) continue
        throw error
      }
      const cost = { providerCurrency: product.providerCurrency, providerAmountCents: billing.pricing.amountCents, fxRate: fx.rate, rules }
      observeCost?.({ id: product.id, name: product.name, location: location.code }, period, cost, fx.createdAt)
      try {
        const price = computePriceFromRules(cost)
        prices.push({ period, totalRial: price.totalRial, billingCycle: billing.native.billingCycle, contractTerm: billing.native.contractTerm })
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error
      }
    }
    if (prices.length === 0) continue
    offers.push({
      id: product.id,
      provider: product.provider,
      location: location.code,
      country: location.country,
      city: location.city,
      name: product.name,
      category: product.category,
      vcpu: product.vcpu,
      memoryMb: product.memoryMb,
      diskGb: product.diskGb,
      diskType: (product.raw as { storageType?: unknown } | null)?.storageType === 'local' ? 'Local' :
        (product.raw as { storageType?: unknown } | null)?.storageType === 'network' ? 'Network' : undefined,
      trafficGb: product.trafficGb,
      ...(product.provider === 'hetzner' ? { includedTrafficBytes: hetznerIncludedTraffic(product, location.code), trafficOverage: indicativeHetznerTraffic(product, location.code, rules, fx) } : {}),
      operatingSystems,
      prices,
    })
  }
  offers.sort((a, b) => a.vcpu - b.vcpu || a.memoryMb - b.memoryMb || a.name.localeCompare(b.name))
  const now = Date.now()
  const offeredIds = new Set(offers.map(offer => offer.id))
  const sources = products.filter(product => offeredIds.has(product.id))
  const catalogTimes = sources.map(product => product.lastSyncedAt.getTime())
  const fxTimes = [...new Set(sources.map(product => product.providerCurrency))].map(currency => ({ currency, fx: fxByCurrency.get(currency)! }))
  return {
    freshness: {
      checkedAt: new Date(now).toISOString(),
      validUntil: new Date(Math.min(now + 60_000,
        ...catalogTimes.map(time => maxAgeMs > 0 ? time + maxAgeMs : Infinity),
        ...fxTimes.map(({ currency, fx }) => fx.createdAt.getTime() + fxMaxAgeMs(currency)),
      )).toISOString(),
      catalogUpdatedAt: catalogTimes.length ? new Date(Math.min(...catalogTimes)).toISOString() : null,
      fxUpdatedAt: fxTimes.length ? new Date(Math.min(...fxTimes.map(({ fx }) => fx.createdAt.getTime()))).toISOString() : null,
    },
    datacenters: active.map((provider) => {
      const providerOffers = offers.filter((offer) => offer.provider === provider.id)
      const codes = new Set(providerOffers.map((offer) => offer.location))
      const periods = new Set(providerOffers.flatMap((offer) => offer.prices.map((price) => price.period)))
      return {
        id: provider.id,
        name: provider.displayName,
        logo: `/providers/${provider.id}.svg`,
        locations: locations.filter((location) => location.provider === provider.id && codes.has(location.code)).map((location) => ({ code: location.code, country: location.country, city: location.city })),
        billingPeriods: (['hourly', 'monthly'] as const).filter((period) => periods.has(period)),
      }
    }),
    offers,
  }
}
