/** Presentation-only projection; canonical offers remain the purchase authority. */
export interface ConsoleOffer {
  id: string; name: string; provider: string; location: string; billingModel: string
  priceMinor: number; currency: string; displayCurrency: string; displayPriceMinor: number | null
  cpu: number; ramGb: number; diskGb: number
}

type Period = 'hourly' | 'monthly'
const periods: Record<string, Period | undefined> = { prepaid_monthly_fixed: 'monthly', hourly: 'hourly' }
const brands: Record<string, { name: string; logo: string }> = {
  hetzner: { name: 'Hetzner', logo: '/providers/hetzner.svg' },
  leaseweb: { name: 'Leaseweb', logo: '/providers/leaseweb.svg' },
  asiatech: { name: 'آسیاتک', logo: '/providers/asiatech.svg' },
}

export function storefrontProjection(rows: ConsoleOffer[]) {
  const offers = rows.flatMap(offer => {
    const period = periods[offer.billingModel]
    // Never manufacture a billing period, FX rate or a payable price.
    if (!period || offer.displayCurrency !== 'IRT' || !Number.isSafeInteger(offer.displayPriceMinor) || offer.displayPriceMinor === null || offer.displayPriceMinor <= 0 || !Number.isSafeInteger(offer.displayPriceMinor * 10) || !Number.isSafeInteger(offer.priceMinor) || offer.priceMinor <= 0) return []
    return [{
      id: offer.id, name: offer.name, provider: offer.provider, location: offer.location,
      category: period === 'monthly' ? 'vps' : 'cloud', vcpu: offer.cpu, memoryMb: offer.ramGb * 1024, diskGb: offer.diskGb,
      trafficGb: null, operatingSystems: [],
      prices: [{ period, totalRial: offer.displayPriceMinor * 10, billingCycle: offer.billingModel }],
      canonicalPricing: { expectedMinor: offer.priceMinor, expectedCurrency: offer.currency },
    }]
  })
  const datacenters = [...new Set(offers.map(offer => offer.provider))].map(id => ({
    id, name: brands[id]?.name ?? id, logo: brands[id]?.logo ?? '/providers/cloud.svg',
    // Location codes are authoritative; no geographic guess from provider codes.
    locations: [...new Set(offers.filter(offer => offer.provider === id).map(offer => offer.location))].map(code => ({ code, country: null, city: null })),
    billingPeriods: [...new Set(offers.filter(offer => offer.provider === id).flatMap(offer => offer.prices.map(price => price.period)))],
  }))
  return { source: 'platform' as const, datacenters, offers }
}
