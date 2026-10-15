import type { ProviderBillingOption, ProviderOffer } from '../provider.interface.js'
import { ProviderRetryableError } from '../../../lib/errors.js'
import { HetznerClient, object } from './client.js'

/** Decimal strings stay decimal until an exactly representable cents projection. */
export function decimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const [whole = '0', fraction = ''] = value.split('.')
  const tail = fraction.replace(/0+$/, '')
  return `${whole.replace(/^0+(?=\d)/, '')}${tail ? `.${tail}` : ''}`
}
export function addDecimals(left: string, right: string): string {
  const [a = '0', af = ''] = left.split('.')
  const [b = '0', bf = ''] = right.split('.')
  const digits = Math.max(af.length, bf.length)
  const total = (BigInt(a + af.padEnd(digits, '0')) + BigInt(b + bf.padEnd(digits, '0'))).toString().padStart(digits + 1, '0')
  return decimal(digits ? `${total.slice(0, -digits)}.${total.slice(-digits)}` : total)!
}
function billing(amount: string): ProviderBillingOption {
  const [whole = '0', fraction = ''] = amount.split('.')
  const cents = fraction.length <= 2 ? Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) : undefined
  return { billingCycle: 'hourly', label: 'Hourly (monthly cap)', amount, ...(cents !== undefined && Number.isSafeInteger(cents) ? { amountCents: cents } : {}) }
}

export interface HetznerCatalog {
  offers: ProviderOffer[]
  locations: Array<{ code: string; country?: string; city?: string }>
}

export async function readCatalog(client: HetznerClient, clean: (value: string) => string): Promise<HetznerCatalog> {
  const [types, locations, images, prices] = await Promise.all([
    client.pages('/server_types', 'server_types'),
    client.pages('/locations', 'locations'),
    client.pages('/images?type=system', 'images'),
    client.request('GET', '/pricing'),
  ])
  const pricing = object(prices.pricing)
  const currency = pricing.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new ProviderRetryableError('Hetzner did not provide a valid pricing currency')
  const ipTypes = Array.isArray(pricing.primary_ips) ? pricing.primary_ips.map(object) : []
  const ipv4 = ipTypes.find((row) => row.type === 'ipv4')
  const ipPrices = Array.isArray(ipv4?.prices) ? ipv4.prices.map(object) : []
  const offers: ProviderOffer[] = []
  const mappedLocations: HetznerCatalog['locations'] = []
  for (const location of locations) {
    if (typeof location.name !== 'string' || !/^[a-z0-9-]+$/.test(location.name)) continue
    const code = location.name
    mappedLocations.push({ code, ...(typeof location.country === 'string' ? { country: clean(location.country) } : {}), ...(typeof location.city === 'string' ? { city: clean(location.city) } : {}) })
    const ipv4Price = ipPrices.find((row) => row.location === code || object(row.location).name === code)
    const ipHourly = decimal(object(ipv4Price?.price_hourly).gross)
    const ipMonthly = decimal(object(ipv4Price?.price_monthly).gross)
    // Missing separately billed IPv4 evidence must never produce an underpriced offer.
    if (ipHourly === undefined) continue
    for (const type of types) {
      if (typeof type.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(type.name) || type.deprecated || type.deprecation) continue
      if (!['x86', 'arm'].includes(String(type.architecture))) continue
      if (typeof type.id !== 'number' || !Number.isSafeInteger(type.id)) continue
      const availability = Array.isArray(type.locations) ? type.locations.map(object) : []
      const declared = availability.find((entry) => entry.name === code || entry.location === code || object(entry.location).name === code)
      // Current Cloud API exposes capacity per server-type location;
      // /datacenters was retired and must not be used as availability evidence.
      if (declared?.available !== true) continue
      const typePrices = Array.isArray(type.prices) ? type.prices.map(object) : []
      const price = typePrices.find((row) => row.location === code || object(row.location).name === code)
      const hourly = decimal(object(price?.price_hourly).gross)
      const monthly = decimal(object(price?.price_monthly).gross)
      if (hourly === undefined || hourly === '0') continue
      const operatingSystems = images.filter((image) => image.type === 'system' && image.status === 'available' && !image.deprecated && !image.deprecation && image.architecture === type.architecture && typeof image.id === 'number' && Number.isSafeInteger(image.id))
        .map((image) => ({ id: String(image.id), label: clean(typeof image.description === 'string' ? image.description : String(image.name ?? image.id)), ...(typeof image.os_flavor === 'string' ? { family: clean(image.os_flavor) } : {}) }))
      if (!operatingSystems.length) continue
      if (typeof type.cores !== 'number' || !Number.isSafeInteger(type.cores) || type.cores <= 0 || typeof type.memory !== 'number' || !Number.isFinite(type.memory) || type.memory <= 0 || typeof type.disk !== 'number' || !Number.isSafeInteger(type.disk) || type.disk <= 0) continue
      const native = billing(addDecimals(hourly, ipHourly))
      const traffic = price?.included_traffic ?? type.included_traffic
      offers.push({
        provider: 'hetzner', providerProductId: `${type.name}:${currency}`, location: code, name: clean(type.name), category: 'cloud',
        vcpu: type.cores, memoryMb: Math.round(type.memory * 1024), diskGb: type.disk,
        trafficGb: typeof traffic === 'number' && Number.isFinite(traffic) && traffic >= 0 ? Math.floor(traffic / 1_000_000_000) : null,
        ipv4Count: 1, ipv6Available: true, providerCurrency: currency,
        providerPriceCents: native.amountCents ?? null, billingOptions: [native], operatingSystems, serviceLevels: [],
        raw: {
          architecture: type.architecture, ipv4Included: true,
          serverHourlyGross: hourly, ipv4HourlyGross: ipHourly,
          ...(monthly !== undefined ? { serverMonthlyCapGross: monthly } : {}),
          ...(ipMonthly !== undefined ? { ipv4MonthlyCapGross: ipMonthly } : {}),
          ...(monthly !== undefined && ipMonthly !== undefined ? { monthlyCapGross: addDecimals(monthly, ipMonthly) } : {}),
        },
      })
    }
  }
  return { offers, locations: mappedLocations }
}
