import type { ProviderBillingOption, ProviderOffer, ProviderOsOption } from '../provider.interface.js'
import { sanitizeLeasewebPayload } from './safety.js'

export type LeasewebRecord = Record<string, unknown>

export function record(value: unknown): LeasewebRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as LeasewebRecord : {}
}

export function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function items(value: unknown, ...keys: string[]): LeasewebRecord[] {
  if (Array.isArray(value)) return value.map(record)
  const root = record(value)
  for (const key of keys) if (Array.isArray(root[key])) return (root[key] as unknown[]).map(record)
  return []
}

export function numeric(value: unknown): number {
  const n = Number(typeof value === 'string' ? value.match(/[\d.]+/)?.[0] : value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Keep decimal major units; integer cents exist only if they are exact. */
export function decimal(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  if (/^\d+(?:\.\d+)?$/.test(raw)) return raw
  const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(raw)
  if (!match || Math.abs(Number(match[3])) > 100) return undefined
  const whole = match[1]!
  const fraction = match[2] ?? ''
  const point = whole.length + Number(match[3])
  const digits = whole + fraction
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

export function exactCents(value: unknown): number | undefined {
  const amount = decimal(value)
  if (!amount) return undefined
  const [whole, fraction = ''] = amount.split('.')
  if (/[1-9]/.test(fraction.slice(2))) return undefined
  const cents = BigInt(whole!) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : undefined
}

export function sameDecimal(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) => decimal(value)?.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const left = canonical(a)
  return left !== undefined && left === canonical(b)
}

export function sizeGb(value: unknown): number {
  const amount = numeric(value)
  const unit = String(value ?? '').toUpperCase()
  if (/\bT(?:I)?B\b/.test(unit)) return amount * 1024
  if (/\bM(?:I)?B\b/.test(unit)) return amount / 1024
  return amount
}

export function freeOptions(value: unknown): ProviderOsOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = record(entry)
    const id = typeof entry === 'string' ? entry : text(row.name ?? row.id ?? row.label)
    // Native configuration options explicitly price OS licenses/SLA upgrades.
    // Only free choices can share the base offer price.
    if (!id || (row.price !== undefined && !sameDecimal(row.price, '0'))) return []
    return [{ id, label: text(row.displayName ?? row.label) ?? id, family: text(row.os ?? row.family) }]
  })
}

function legacyBilling(configuration: LeasewebRecord, price: LeasewebRecord): ProviderBillingOption[] {
  const cycles = Array.isArray(configuration.billingCycles) ? configuration.billingCycles : []
  const independentTerms = Array.isArray(configuration.contractTerms) ? configuration.contractTerms : []
  return cycles.flatMap((entry): ProviderBillingOption[] => {
    const cycle = record(entry)
    const id = typeof entry === 'string' ? entry : text(cycle.id ?? cycle.label)
    const cyclePrice = record(cycle.price)
    const amount = decimal(cyclePrice.amount ?? price.amount)
    if (!id || amount === undefined) return []
    const base = { billingCycle: id, label: text(cycle.label) ?? id, amount, amountCents: exactCents(amount) }
    if (Array.isArray(cycle.contractTerms) && cycle.contractTerms.length) {
      return cycle.contractTerms.flatMap((term): ProviderBillingOption[] => {
        const value = typeof term === 'string' || typeof term === 'number' ? term : text(record(term).id)
        return value === undefined ? [] : [{ ...base, contractTerm: value }]
      })
    }
    return independentTerms.length ? [] : [base]
  })
}

export function normalizeVpsDetail(
  input: unknown,
  location: string,
  selected?: { billingCycle: string; contractTerm?: string | number },
): ProviderOffer | undefined {
  const envelope = record(input)
  const detail = record(envelope.vps ?? input)
  const id = text(detail.id)
  if (!id) return undefined
  const price = record(detail.price)
  const configuration = record(detail.configuration)
  const nativeConfiguration = record(detail.configurationOptions)
  const native = detail.configurationOptions !== undefined || detail.vCpu !== undefined || price.total !== undefined
  const currency = text(price.currency)
  const amount = decimal(native ? price.total : price.amount)
  let billingOptions: ProviderBillingOption[] = []
  if (native) {
    // The live API's selected fields are descriptions, not order enum keys.
    const cycleRow = items(price, 'billingCycles').find((row) => row.key === price.billingCycle || row.description === price.billingCycle)
    const termRow = items(price, 'contractTerms').find((row) => row.key === price.contractTerm || row.description === price.contractTerm)
    const provenCycle = text(cycleRow?.key)
    const provenTerm = text(termRow?.key)
    const billingCycle = provenCycle ?? selected?.billingCycle
    const contractTerm = provenTerm ?? selected?.contractTerm
    const selectedMatches = (!selected || ((!provenCycle || provenCycle === selected.billingCycle) && (!provenTerm || provenTerm === String(selected.contractTerm))))
    if (selectedMatches && amount !== undefined && billingCycle && contractTerm !== undefined && currency) {
      billingOptions = [{ billingCycle, contractTerm, amount, amountCents: exactCents(amount) }]
    }
  } else {
    billingOptions = legacyBilling(configuration, price)
  }
  const declaredLocations = Array.isArray(detail.location) ? detail.location : []
  if (declaredLocations.length && !declaredLocations.includes(location)) return undefined
  const operatingSystems = freeOptions(native ? nativeConfiguration.operatingSystem : configuration.operatingSystems)
  return {
    provider: 'leaseweb',
    providerProductId: id,
    category: 'vps',
    location,
    name: text(detail.name ?? detail.description) ?? id,
    vcpu: numeric(detail.vCpu ?? configuration.vcpu ?? detail.vcpu),
    memoryMb: detail.vRam !== undefined ? sizeGb(detail.vRam) * 1024 : numeric(configuration.memoryMb ?? detail.memoryMb),
    diskGb: sizeGb(detail.nvmeStorage ?? configuration.diskGb ?? detail.diskGb),
    trafficGb: detail.traffic !== undefined ? (sizeGb(detail.traffic) || null) : (numeric(configuration.trafficGb ?? detail.trafficGb) || null),
    ipv4Count: numeric(configuration.ipv4Count ?? detail.ipv4Count) || 1,
    ipv6Available: Boolean(configuration.ipv6 ?? detail.ipv6 ?? true),
    providerCurrency: currency ?? '',
    providerPriceCents: exactCents(amount) ?? null,
    billingOptions,
    operatingSystems,
    serviceLevels: freeOptions(native ? nativeConfiguration.serviceLevelAgreement : configuration.serviceLevels),
    raw: sanitizeLeasewebPayload(detail),
  }
}

/** Public pure normalizer also accepts the historical detailed fixture shape. */
export function normalizeCatalog(raw: unknown): {
  offers: ProviderOffer[]
  locations: Array<{ code: string; country?: string; city?: string }>
  raw: unknown
} {
  const offers: ProviderOffer[] = []
  const locations = new Map<string, { code: string }>()
  for (const detail of items(raw, 'vpss', 'products')) {
    const cfg = record(detail.configuration)
    const declared = Array.isArray(detail.location) ? detail.location : Array.isArray(cfg.locations) ? cfg.locations : []
    for (const location of declared) {
      const code = typeof location === 'string' ? location : text(record(location).id ?? record(location).label)
      if (!code) continue
      const offer = normalizeVpsDetail(detail, code)
      if (!offer) continue
      offers.push(offer)
      locations.set(code, { code })
    }
  }
  return { offers, locations: [...locations.values()], raw: sanitizeLeasewebPayload(raw) }
}
