import type { ProviderBillingOption, ProviderOffer } from '../provider.interface.js'
import { ProviderRetryableError } from '../../../lib/errors.js'
import { HetznerClient, object } from './client.js'
import { hetznerPrepaidMonth } from '../../pricing/periods.js'
import { isTrafficByteCount } from '../../../contracts/home-tariffs.js'

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
function billing(amount: string, cycle: 'hourly' | typeof hetznerPrepaidMonth): ProviderBillingOption {
  const [whole = '0', fraction = ''] = amount.split('.')
  const cents = fraction.length <= 2 ? Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) : undefined
  return { billingCycle: cycle, label: cycle === 'hourly' ? 'Hourly (monthly cap)' : 'Prepaid retail month', amount,
    ...(cents !== undefined && Number.isSafeInteger(cents) ? { amountCents: cents } : {}) }
}

function gross(value: unknown): string | undefined {
  const amount = decimal(object(value).gross)
  // Match the provider-amount precision and safe scaling of the retail engine.
  return amount && /^\d{1,7}(?:\.\d{1,8})?$/.test(amount) ? amount : undefined
}

const nonzeroGross = (value: unknown) => {
  const amount = gross(value)
  return amount === '0' ? undefined : amount
}
const priceRows = (rows: unknown) => Array.isArray(rows) ? rows.map(object) : []
const atLocation = (row: Record<string, unknown>, code: string) => row.location === code || object(row.location).name === code
const currencyMatches = (row: Record<string, unknown>, currency: string) => row.currency === undefined || row.currency === currency

function monthlyMissingReason(rows: Record<string, unknown>[], code: string, currency: string, component: 'server' | 'ipv4') {
  const priced = rows.filter(row => row.price_monthly != null)
  if (!priced.length) return `${component}_monthly_missing`
  const regional = priced.filter(row => atLocation(row, code))
  if (!regional.length) return `${component}_location_mismatch`
  const compatible = regional.filter(row => currencyMatches(row, currency))
  return compatible.length ? `${component}_monthly_invalid` : `${component}_currency_mismatch`
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
  const ipTypes = priceRows(pricing.primary_ips)
  const ipv4 = ipTypes.find((row) => row.type === 'ipv4')
  const ipPrices = priceRows(ipv4?.prices)
  const pricedTypes = priceRows(pricing.server_types)
  const offers: ProviderOffer[] = []
  const mappedLocations: HetznerCatalog['locations'] = []
  for (const location of locations) {
    if (typeof location.name !== 'string' || !/^[a-z0-9-]+$/.test(location.name)) continue
    const code = location.name
    mappedLocations.push({ code, ...(typeof location.country === 'string' ? { country: clean(location.country) } : {}), ...(typeof location.city === 'string' ? { city: clean(location.city) } : {}) })
    const matches = (row: Record<string, unknown>) => currencyMatches(row, currency) && atLocation(row, code)
    const ipv4Price = ipPrices.find(matches)
    const ipHourly = gross(ipv4Price?.price_hourly)
    const ipMonthly = gross(ipv4Price?.price_monthly)
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
      const typePrices = priceRows(type.prices)
      const price = typePrices.find(matches)
      const hourly = gross(price?.price_hourly)
      if (hourly === undefined || hourly === '0') continue
      const operatingSystems = images.filter((image) => image.type === 'system' && image.status === 'available' && !image.deprecated && !image.deprecation && image.architecture === type.architecture && typeof image.id === 'number' && Number.isSafeInteger(image.id))
        .map((image) => ({ id: String(image.id), label: clean(typeof image.description === 'string' ? image.description : String(image.name ?? image.id)), ...(typeof image.os_flavor === 'string' ? { family: clean(image.os_flavor) } : {}) }))
      if (!operatingSystems.length) continue
      if (typeof type.cores !== 'number' || !Number.isSafeInteger(type.cores) || type.cores <= 0 || typeof type.memory !== 'number' || !Number.isFinite(type.memory) || type.memory <= 0 || typeof type.disk !== 'number' || !Number.isSafeInteger(type.disk) || type.disk <= 0) continue
      const native = billing(addDecimals(hourly, ipHourly), 'hourly')
      const pricedType = pricedTypes.find(row => row.id === type.id && row.name === type.name)
      const regionalPrices = priceRows(pricedType?.prices)
      const regionalPrice = regionalPrices.find(matches)
      const monthly = nonzeroGross(price?.price_monthly) ?? nonzeroGross(regionalPrice?.price_monthly)
      const monthlyCap = monthly && ipMonthly !== undefined ? addDecimals(monthly, ipMonthly) : undefined
      const monthlyUnavailableReasons = [
        ...(!monthly ? [monthlyMissingReason([...typePrices, ...regionalPrices], code, currency, 'server')] : []),
        ...(ipMonthly === undefined ? [monthlyMissingReason(ipPrices, code, currency, 'ipv4')] : []),
      ]
      // Allowance and overage are independent, but both belong to this type,
      // location and project currency.
      const includedTrafficBytes = [price?.included_traffic, regionalPrice?.included_traffic].find(isTrafficByteCount) ?? null
      const grossPerTb = nonzeroGross(price?.price_per_tb_traffic) ?? nonzeroGross(regionalPrice?.price_per_tb_traffic)
      offers.push({
        provider: 'hetzner', providerProductId: `${type.name}:${currency}`, location: code, name: clean(type.name), category: 'cloud',
        vcpu: type.cores, memoryMb: Math.round(type.memory * 1024), diskGb: type.disk,
        trafficGb: includedTrafficBytes === null ? null : Math.floor(includedTrafficBytes / 1_000_000_000),
        ipv4Count: 1, ipv6Available: true, providerCurrency: currency,
        providerPriceCents: native.amountCents ?? null, billingOptions: monthlyCap ? [native, billing(monthlyCap, hetznerPrepaidMonth)] : [native], operatingSystems, serviceLevels: [],
        raw: {
          storageType: type.storage_type,
          architecture: type.architecture, ipv4Included: true,
          serverHourlyGross: hourly, ipv4HourlyGross: ipHourly,
          ...(monthly !== undefined ? { serverMonthlyCapGross: monthly } : {}),
          ...(ipMonthly !== undefined ? { ipv4MonthlyCapGross: ipMonthly } : {}),
          ...(monthlyCap ? { monthlyCapGross: monthlyCap } : {}),
          ...(monthlyUnavailableReasons.length ? { monthlyUnavailableReasons } : {}),
          includedTrafficBytes,
          ...(grossPerTb ? {
            trafficTariff: { source: 'hetzner-server-type-location', location: code, currency, grossPerTb, includedTrafficBytes },
          } : {}),
        },
      })
    }
  }
  return { offers, locations: mappedLocations }
}
