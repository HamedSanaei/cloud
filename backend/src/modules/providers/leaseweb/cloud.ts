import { ProviderPermanentError } from '../../../lib/errors.js'
import type { ProviderOffer, ProviderOrderRequest } from '../provider.interface.js'
import { LeasewebClient } from './client.js'
import { decimal, exactCents, items, numeric, record, sameDecimal, text, type LeasewebRecord } from './catalog.js'
import { sanitizeLeasewebPayload } from './safety.js'

// Native Cloud regions and VPS datacenters use different identifiers. These
// geography associations are shared by the reference production adapter.
const CLOUD_SITES: Record<string, { site: string; country: string; city: string }> = {
  'eu-central-1': { site: 'FRA-01', country: 'DE', city: 'Frankfurt' },
  'eu-west-2': { site: 'LON-01', country: 'GB', city: 'London' },
  'eu-west-3': { site: 'AMS-01', country: 'NL', city: 'Amsterdam' },
  'us-east-1': { site: 'WDC-02', country: 'US', city: 'Washington' },
  'us-west-1': { site: 'SFO-12', country: 'US', city: 'San Francisco' },
  'ca-central-1': { site: 'MTL-02', country: 'CA', city: 'Montreal' },
  'ap-southeast-1': { site: 'SIN-01', country: 'SG', city: 'Singapore' },
  'ap-northeast-1': { site: 'TYO-11', country: 'JP', city: 'Tokyo' },
}

export function isCatalogExclusion(error: unknown): boolean {
  const status = record(record(error).details).status
  return error instanceof ProviderPermanentError && (status === 400 || status === 403 || status === 404)
}

export function cloudLocationAllowed(region: string, configured: string[]): boolean {
  if (!configured.length) return true
  const upper = region.toUpperCase()
  const site = CLOUD_SITES[region]?.site
  return configured.some((code) => code.toUpperCase() === upper || code.toUpperCase() === site)
}

function rootDisk(type: LeasewebRecord, image: LeasewebRecord): { size: number; storage: string } | undefined {
  const minimum = numeric(type.minDiskSize ?? type.rootDiskSize ?? record(type.resources).disk ?? type.disk)
  if (!minimum || !Number.isInteger(minimum)) return undefined
  const imageFloor = Math.max(5, numeric(image.minDiskSize) || (/windows/i.test(`${text(image.os ?? image.family) ?? ''} ${text(image.displayName ?? image.name) ?? ''}`) ? 50 : 5))
  const size = Math.max(minimum, imageFloor)
  if (size > 1000 || !Number.isInteger(size)) return undefined
  const typeStorage = Array.isArray(type.storageTypes) ? type.storageTypes.map((value) => String(value).toUpperCase()) : text(type.storageType) ? [String(type.storageType).toUpperCase()] : []
  const imageStorage = Array.isArray(image.storageTypes) ? image.storageTypes.map((value) => String(value).toUpperCase()) : []
  const preferred = typeStorage[0]
  for (const storage of [preferred, 'CENTRAL', 'LOCAL']) {
    if (!storage || !['CENTRAL', 'LOCAL'].includes(storage)) continue
    if (typeStorage.length && !typeStorage.includes(storage)) continue
    if (imageStorage.length && !imageStorage.includes(storage)) continue
    return { size, storage }
  }
  return undefined
}

function compatibleImages(type: LeasewebRecord, images: LeasewebRecord[]): LeasewebRecord[] {
  const architecture = text(type.architecture)?.toLowerCase()
  return images.filter((image) => {
    if (!text(image.id ?? image.name)) return false
    const imageArchitecture = text(image.architecture)?.toLowerCase()
    if (architecture && imageArchitecture && architecture !== imageArchitecture) return false
    if (image.price !== undefined && !sameDecimal(record(image.price).value ?? image.price, '0')) return false
    return rootDisk(type, image) !== undefined
  })
}

export function normalizeCloudTypes(raw: unknown, imagePayload: unknown, region: string): ProviderOffer[] {
  const currency = text(record(record(raw)._metadata).currency)?.toUpperCase()
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return []
  const images = items(imagePayload, 'images', 'data', 'items')
  return items(raw, 'instanceTypes', 'types', 'data', 'items').flatMap((type): ProviderOffer[] => {
    const id = text(type.name ?? type.id)
    const rate = decimal(record(type.prices).hourly ?? type.pricePerHour ?? type.price_per_hour)
    const operatingSystems = compatibleImages(type, images).map((image) => ({
      id: text(image.id ?? image.name)!,
      label: text(image.displayName ?? image.name ?? image.id),
      family: text(image.os ?? image.family),
    }))
    if (!id || !rate || !/[1-9]/.test(rate) || !operatingSystems.length) return []
    const resources = record(type.resources)
    const memory = record(resources.memory)
    const memoryValue = memory.value !== undefined ? numeric(memory.value) : numeric(type.memoryGb ?? type.memoryMB ?? type.memoryMb ?? type.memory ?? resources.memory)
    const unit = text(memory.unit) ?? (type.memoryMB !== undefined || type.memoryMb !== undefined ? 'MB' : 'GiB')
    const memoryMb = /^(MIB|MB)$/i.test(unit) ? memoryValue : memoryValue * 1024
    return [{
      provider: 'leaseweb',
      providerProductId: id,
      category: 'cloud',
      location: region,
      name: text(type.displayName) ?? id,
      vcpu: numeric(record(resources.cpu).value ?? type.cpu ?? type.vcpus ?? resources.cpu),
      memoryMb,
      diskGb: numeric(type.minDiskSize ?? type.rootDiskSize ?? resources.disk ?? type.disk),
      trafficGb: null,
      ipv4Count: 1,
      ipv6Available: false,
      providerCurrency: currency,
      providerPriceCents: exactCents(rate) ?? null,
      billingOptions: [{ billingCycle: 'HOURLY', amount: rate, amountCents: exactCents(rate), source: 'publicCloud/v1/instanceTypes.prices.hourly' }],
      operatingSystems,
      serviceLevels: [],
      raw: sanitizeLeasewebPayload(type),
    }]
  })
}

export async function readCloudCatalog(client: LeasewebClient, configured: string[]): Promise<{
  offers: ProviderOffer[]
  locations: Array<{ code: string; country?: string; city?: string }>
}> {
  const regions = await client.get<unknown>('/publicCloud/v1/regions')
  if (!Array.isArray(regions) && !['regions', 'data', 'items'].some((key) => Array.isArray(record(regions)[key]))) throw new ProviderPermanentError('Leaseweb Cloud region response is incomplete')
  const offers: ProviderOffer[] = []
  const locations: Array<{ code: string; country?: string; city?: string }> = []
  for (const region of items(regions, 'regions', 'data', 'items')) {
    const code = text(region.name ?? region.id ?? region.code)
    if (!code || !cloudLocationAllowed(code, configured)) continue
    try {
      // A global image list is NOT ownership evidence: the region-scoped read
      // must succeed for this credential, exactly as in the production adapter.
      const types = await client.get<unknown>(`/publicCloud/v1/instanceTypes?region=${encodeURIComponent(code)}`)
      const images = await client.get<unknown>(`/publicCloud/v1/images?region=${encodeURIComponent(code)}`)
      if (!Array.isArray(types) && !['instanceTypes', 'types', 'data', 'items'].some((key) => Array.isArray(record(types)[key]))) throw new ProviderPermanentError('Leaseweb Cloud instance-type response is incomplete')
      if (!Array.isArray(images) && !['images', 'data', 'items'].some((key) => Array.isArray(record(images)[key]))) throw new ProviderPermanentError('Leaseweb Cloud image response is incomplete')
      const regionalOffers = normalizeCloudTypes(types, images, code)
      offers.push(...regionalOffers)
      if (regionalOffers.length) locations.push({
        code,
        country: text(region.country ?? region.countryCode) ?? CLOUD_SITES[code]?.country,
        city: text(region.city) ?? CLOUD_SITES[code]?.city,
      })
    } catch (error) {
      if (!isCatalogExclusion(error)) throw error
    }
  }
  return { offers, locations }
}

export async function cloudCreateBody(client: LeasewebClient, req: ProviderOrderRequest): Promise<LeasewebRecord> {
  if (req.billingOption.billingCycle !== 'HOURLY') throw new ProviderPermanentError('Leaseweb Cloud requires its native HOURLY billing option')
  const typesPayload = await client.get<unknown>(`/publicCloud/v1/instanceTypes?region=${encodeURIComponent(req.location)}`)
  const imagesPayload = await client.get<unknown>(`/publicCloud/v1/images?region=${encodeURIComponent(req.location)}`)
  const live = normalizeCloudTypes(typesPayload, imagesPayload, req.location).find((offer) => offer.providerProductId === req.productId)
  if (!live || !live.operatingSystems.some((image) => image.id === req.operatingSystem)) throw new ProviderPermanentError('Leaseweb Cloud type or image is not currently launchable in this region')
  const amount = req.billingOption.amount ?? (req.billingOption.amountCents === undefined ? undefined : String(req.billingOption.amountCents / 100))
  if (!sameDecimal(live.billingOptions[0]?.amount, amount)) throw new ProviderPermanentError('Leaseweb Cloud hourly price changed; select the current offer')
  const type = items(typesPayload, 'instanceTypes', 'types', 'data', 'items').find((item) => text(item.name ?? item.id) === req.productId)!
  const image = items(imagesPayload, 'images', 'data', 'items').find((item) => text(item.id ?? item.name) === req.operatingSystem)!
  const disk = rootDisk(type, image)!
  const reference = req.clientReference ?? req.hostname
  if (req.clientReference && req.clientReference.length > 64) throw new ProviderPermanentError('Leaseweb Cloud client reference exceeds 64 characters')
  return {
    type: req.productId,
    imageId: req.operatingSystem,
    region: req.location,
    contractType: 'HOURLY',
    rootDiskSize: disk.size,
    rootDiskStorageType: disk.storage,
    ...(reference ? { reference: reference.slice(0, 64) } : {}),
  }
}
