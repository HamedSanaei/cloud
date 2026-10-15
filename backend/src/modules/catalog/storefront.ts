import { eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { getConfig } from '../../config.js'
import { ValidationError } from '../../lib/errors.js'
import { computePriceFromRules, getActiveFxRate, getPricingRules } from '../pricing/service.js'
import { offeredPeriods, retailBilling, type RetailPeriod } from '../pricing/periods.js'
import type { ProviderBillingOption, ProviderOsOption } from '../providers/provider.interface.js'
import { listProviders } from '../providers/registry.js'

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
  name: string
  category: string
  vcpu: number
  memoryMb: number
  diskGb: number
  trafficGb: number | null
  operatingSystems: ProviderOsOption[]
  prices: StorefrontPrice[]
}
export async function getStorefront(db: DbClient) {
  const config = getConfig()
  const registered = new Set(listProviders().map((provider) => provider.id))
  const configured = [
    { id: 'hetzner', ...config.PROVIDERS.hetzner },
    { id: 'leaseweb', ...config.PROVIDERS.leaseweb },
  ].filter((provider) => provider.enabled && provider.orderingEnabled && registered.has(provider.id))
  const providerRows = await db.query.providers.findMany({ where: (t) => eq(t.enabled, true) })
  const active = configured.filter((provider) => providerRows.some((row) => row.id === provider.id && row.mode === 'live'))
  const activeIds = new Set(active.map((provider) => provider.id))
  const [products, locations] = await Promise.all([
    db.query.providerProducts.findMany({ where: (t, { and }) => and(eq(t.available, true), eq(t.enabled, true)) }),
    db.query.providerLocations.findMany({ where: (t) => eq(t.available, true) }),
  ])
  const locationById = new Map(locations.map((location) => [location.id, location]))
  const pricingKeys = [...new Set(products.filter((product) => activeIds.has(product.provider)).map((product) => product.provider === 'leaseweb' && product.category === 'cloud' ? 'leaseweb.hourly' : product.provider))]
  const rulesByProvider = new Map(await Promise.all(pricingKeys.map(async (key) => [key, await getPricingRules(db, key)] as const)))
  const currencies = [...new Set(products.filter((product) => activeIds.has(product.provider)).map((product) => product.providerCurrency))]
  const fxByCurrency = new Map(await Promise.all(currencies.map(async (currency) => [currency, await getActiveFxRate(db, currency)] as const)))
  const maxAgeMs = config.CATALOG_MAX_AGE_MINUTES * 60_000
  const offers: StorefrontOffer[] = []
  for (const product of products) {
    if (!activeIds.has(product.provider)) continue
    if (maxAgeMs > 0 && Date.now() - product.lastSyncedAt.getTime() > maxAgeMs) continue
    const location = locationById.get(product.locationId ?? '')
    const rules = rulesByProvider.get(product.provider === 'leaseweb' && product.category === 'cloud' ? 'leaseweb.hourly' : product.provider)
    const fx = fxByCurrency.get(product.providerCurrency)
    if (!location || !rules?.enabled || !fx) continue
    const options = (product.billingOptions ?? []) as ProviderBillingOption[]
    const operatingSystems = (product.operatingSystems ?? []) as ProviderOsOption[]
    if (operatingSystems.length === 0) continue
    const prices: StorefrontPrice[] = []
    for (const period of offeredPeriods(options)) {
      try {
        const billing = retailBilling(options, period)
        const price = computePriceFromRules({
          providerCurrency: product.providerCurrency,
          providerAmountCents: billing.pricing.amountCents,
          fxRate: fx.rate,
          rules,
        })
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
      name: product.name,
      category: product.category,
      vcpu: product.vcpu,
      memoryMb: product.memoryMb,
      diskGb: product.diskGb,
      trafficGb: product.trafficGb,
      operatingSystems,
      prices,
    })
  }
  offers.sort((a, b) => a.vcpu - b.vcpu || a.memoryMb - b.memoryMb || a.name.localeCompare(b.name))
  return {
    datacenters: active.map((provider) => {
      const providerOffers = offers.filter((offer) => offer.provider === provider.id)
      const codes = new Set(providerOffers.map((offer) => offer.location))
      const periods = new Set(providerOffers.flatMap((offer) => offer.prices.map((price) => price.period)))
      return {
        id: provider.id,
        name: provider.displayName,
        logo: `/providers/${provider.id}.svg`,
        locations: locations.filter((location) => location.provider === provider.id && codes.has(location.code)).map((location) => ({ code: location.code, country: location.country, city: location.city })),
        billingPeriods: (['hourly', 'daily', 'monthly'] as const).filter((period) => periods.has(period)),
      }
    }),
    offers,
  }
}
