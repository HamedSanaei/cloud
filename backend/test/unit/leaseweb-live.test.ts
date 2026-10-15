import { afterEach, describe, expect, it, vi } from 'vitest'
import { pino } from 'pino'
import { createLiveLeasewebProvider, type LiveLeasewebOptions } from '../../src/modules/providers/leaseweb/live.js'
import { normalizeVpsDetail } from '../../src/modules/providers/leaseweb/catalog.js'
import { normalizeCloudTypes } from '../../src/modules/providers/leaseweb/cloud.js'
import { ProviderPermanentError, ProviderRetryableError, ProviderUnknownError } from '../../src/lib/errors.js'

const logger = pino({ level: 'silent' })
const options: LiveLeasewebOptions = {
  enabled: true, displayName: 'Leaseweb', baseUrl: 'https://api.leaseweb.test', orderingEnabled: true, logger,
  accounts: [
    { id: 'primary', enabled: true, state: 'active', priority: 200, label: 'Primary', apiKey: 'primary-test-key' },
    { id: 'second', enabled: true, state: 'active', priority: 100, label: 'Second', apiKey: 'second-test-key' },
  ],
  locations: ['FRA-01', 'LON-01'],
  families: { vps: { enabled: true }, cloud: { enabled: true } },
}
const monthly = { billingCycle: '1_MONTH', contractTerm: '1_MONTH', amount: '5.50', amountCents: 550 }
const nativeVps = {
  id: 'VPS02_1', name: 'Real VPS', vCpu: '2', vRam: '4', nvmeStorage: '100 GB', traffic: '2 TB',
  location: ['FRA-01', 'LON-01'],
  price: {
    currency: 'EUR', total: '5.50', billingCycle: '1 month', contractTerm: '1 month',
    billingCycles: [{ key: '1_MONTH', description: '1 month', total: '5.50' }],
    contractTerms: [{ key: '1_MONTH', description: '1 month', total: '5.50' }, { key: '12_MONTH', description: '12 months', total: '4.50' }],
  },
  configurationOptions: {
    operatingSystem: [{ name: 'Ubuntu 24.04', price: '0' }, { name: 'Windows', price: '12' }],
    serviceLevelAgreement: [{ name: 'Basic', price: '0' }],
  },
}
const types = {
  _metadata: { currency: 'GBP' },
  instanceTypes: [{
    name: 'lsw.gp.test', displayName: 'Real Cloud', architecture: 'x86_64', minDiskSize: 5,
    resources: { cpu: { value: 2, unit: 'vCPU' }, memory: { value: '3.5', unit: 'GiB' } },
    storageTypes: ['LOCAL', 'CENTRAL'], prices: { hourly: '0.00395', monthly: '2.8835' },
  }],
}
const images = { images: [
  { id: 'ubuntu', displayName: 'Ubuntu', architecture: 'x86_64', minDiskSize: 10, storageTypes: ['CENTRAL'], price: { value: '0', currency: 'GBP' } },
  { id: 'licensed', displayName: 'Windows', architecture: 'x86_64', minDiskSize: 50, storageTypes: ['CENTRAL'], price: { value: '0.01', currency: 'GBP' } },
] }

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
afterEach(() => vi.restoreAllMocks())

describe('Leaseweb native commercial evidence', () => {
  it('normalizes real VPS detail with exact monthly enum keys and free OS options', () => {
    const offer = normalizeVpsDetail({ vps: nativeVps }, 'FRA-01', monthly)!
    expect(offer).toMatchObject({ category: 'vps', vcpu: 2, memoryMb: 4096, diskGb: 100, trafficGb: 2048, providerCurrency: 'EUR' })
    expect(offer.billingOptions).toEqual([monthly])
    expect(offer.operatingSystems.map((os) => os.id)).toEqual(['Ubuntu 24.04'])
    expect(offer.billingOptions.some((price) => /hour/i.test(price.billingCycle))).toBe(false)
  })

  it('rejects an explicit query whose returned selected enum evidence differs', () => {
    const offer = normalizeVpsDetail({ vps: nativeVps }, 'FRA-01', { ...monthly, contractTerm: '12_MONTH' })!
    expect(offer.billingOptions).toEqual([])
  })

  it('preserves sub-cent hourly rates and excludes paid image licenses', () => {
    const [offer] = normalizeCloudTypes(types, images, 'eu-west-2')
    expect(offer).toMatchObject({ category: 'cloud', memoryMb: 3584, diskGb: 5, providerCurrency: 'GBP', providerPriceCents: null })
    expect(offer!.billingOptions).toEqual([{ billingCycle: 'HOURLY', amount: '0.00395', amountCents: undefined, source: 'publicCloud/v1/instanceTypes.prices.hourly' }])
    expect(offer!.operatingSystems.map((os) => os.id)).toEqual(['ubuntu'])
    expect(normalizeCloudTypes({ ...types, _metadata: {} }, images, 'eu-west-2')).toEqual([])
  })
})

describe('Leaseweb credential ownership and live ordering', () => {
  it('pins bare historical resource ids to first configuration, not highest priority', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe('/publicCloud/v1/vps/legacy-id')
      expect((init!.headers as Record<string, string>)['X-LSW-Auth']).toBe('primary-test-key')
      return response({ id: 'legacy-id', state: 'RUNNING', reference: 'existing', ips: [{ ip: '192.0.2.1', version: 4 }] })
    })
    expect(await createLiveLeasewebProvider(options).getServer('legacy-id')).toMatchObject({ providerServerId: 'legacy-id', state: 'active', ipv4: '192.0.2.1' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends a provider-proven VPS payload and never treats orderId as serverId', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect((init!.headers as Record<string, string>)['X-LSW-Auth']).toBe('second-test-key')
      const parsed = new URL(String(url))
      if (init!.method === 'GET') {
        expect(parsed.searchParams.get('location')).toBe('LON-01')
        expect(parsed.searchParams.get('billingCycle')).toBe('1_MONTH')
        expect(parsed.searchParams.get('contractTerm')).toBe('1_MONTH')
        return response({ vps: nativeVps })
      }
      expect(parsed.pathname).toBe('/ordering/v1/products/vps/VPS02_1/order')
      expect(JSON.parse(String(init!.body))).toEqual({ location: 'LON-01', operatingSystem: 'Ubuntu 24.04', billingCycle: '1_MONTH', contractTerm: '1_MONTH' })
      return response({ orderId: 12345 }, 201)
    })
    const order = await createLiveLeasewebProvider(options).createServer({ productId: 'lsw:second:vps:VPS02_1', location: 'LON-01', operatingSystem: 'Ubuntu 24.04', billingOption: monthly })
    expect(order).toMatchObject({ providerOrderId: 'lsw:second:vps:12345', state: 'pending' })
    expect(order.providerServerId).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('creates hourly Cloud with real image/type root-disk requirements and no invented fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect((init!.headers as Record<string, string>)['X-LSW-Auth']).toBe('second-test-key')
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/instanceTypes')) return response(types)
      if (parsed.pathname.endsWith('/images')) return response(images)
      expect(parsed.pathname).toBe('/publicCloud/v1/instances')
      expect(JSON.parse(String(init!.body))).toEqual({ type: 'lsw.gp.test', imageId: 'ubuntu', region: 'eu-west-2', contractType: 'HOURLY', rootDiskSize: 10, rootDiskStorageType: 'CENTRAL', reference: 'operation-unique-reference' })
      return response({ instance: { id: 'cloud-1', state: 'CREATING' } }, 201)
    })
    const order = await createLiveLeasewebProvider(options).createServer({ productId: 'lsw:second:cloud:lsw.gp.test', location: 'eu-west-2', operatingSystem: 'ubuntu', clientReference: 'operation-unique-reference', billingOption: { billingCycle: 'HOURLY', amount: '0.00395' } })
    expect(order).toMatchObject({ providerOrderId: 'lsw:second:cloud:cloud-1', providerServerId: 'lsw:second:cloud:cloud-1', state: 'pending' })
  })

  it('does not switch credentials after an ambiguous management mutation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect((init!.headers as Record<string, string>)['X-LSW-Auth']).toBe('second-test-key')
      return response({ error: 'unavailable' }, 503)
    })
    await expect(createLiveLeasewebProvider(options).reboot('lsw:second:cloud:cloud-1')).rejects.toBeInstanceOf(ProviderUnknownError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never falls back when a pinned credential was removed', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(createLiveLeasewebProvider({ ...options, accounts: options.accounts.slice(0, 1) }).powerOn('lsw:second:vps:server-1')).rejects.toBeInstanceOf(ProviderPermanentError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('recovers only exact VPS equipment ids supplied by the original account order', async () => {
    const paths: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect((init!.headers as Record<string, string>)['X-LSW-Auth']).toBe('second-test-key')
      const path = new URL(String(url)).pathname
      paths.push(path)
      if (path === '/account/v1/orders/123') return response({ id: '123', services: [{ productId: 'VIRTUAL_SERVER', equipmentId: 'vps-real' }, { productId: 'DEDICATED_SERVER', equipmentId: 'unrelated' }] })
      expect(path).toBe('/publicCloud/v1/vps/vps-real')
      return response({ id: 'vps-real', state: 'RUNNING' })
    })
    const recovered = await createLiveLeasewebProvider(options).reconcileOrder!({ knownProviderOrderId: 'lsw:second:vps:123' })
    expect(recovered).toMatchObject({ resolution: 'MATCHED', providerServerId: 'lsw:second:vps:vps-real' })
    expect(paths).toHaveLength(2)
  })
})

describe('Leaseweb full catalog scope safety', () => {
  it('discovers account-owned VPS scopes and publishes one preferred credential per product/site', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url))
      const key = (init!.headers as Record<string, string>)['X-LSW-Auth']
      const location = parsed.searchParams.get('location')
      if ((key === 'primary-test-key' && location !== 'FRA-01') || (key === 'second-test-key' && location !== 'LON-01')) return response({}, 403)
      return response(parsed.pathname.endsWith('/VPS02_1') ? { vps: nativeVps } : { vpss: [{ id: 'VPS02_1' }], _metadata: { totalCount: 1 } })
    })
    const catalog = await createLiveLeasewebProvider({ ...options, families: { vps: { enabled: true }, cloud: { enabled: false } } }).syncCatalog()
    expect(catalog.offers.map((offer) => [offer.providerProductId, offer.location])).toEqual([['lsw:second:vps:VPS02_1', 'LON-01'], ['lsw:primary:vps:VPS02_1', 'FRA-01']])
    expect(JSON.stringify(catalog)).not.toContain('test-key')
  })

  it('matches configured datacenters to native regions without probing unconfigured cloud sites', async () => {
    const queried: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/regions')) return response({ regions: [{ name: 'eu-west-2' }, { name: 'eu-west-3' }] })
      queried.push(parsed.searchParams.get('region')!)
      return response(parsed.pathname.endsWith('/images') ? images : types)
    })
    const catalog = await createLiveLeasewebProvider({ ...options, accounts: [options.accounts[1]!], locations: ['LON-01'], families: { vps: { enabled: false }, cloud: { enabled: true } } }).syncCatalog()
    expect(catalog.offers).toHaveLength(1)
    expect(catalog.offers[0]).toMatchObject({ providerProductId: 'lsw:second:cloud:lsw.gp.test', location: 'eu-west-2' })
    expect(queried).toEqual(['eu-west-2', 'eu-west-2'])
  })

  it('does not use a global image catalog to claim an account can launch in a rejected region', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/regions')) return response({ regions: [{ name: 'eu-west-2' }] })
      if (parsed.pathname.endsWith('/instanceTypes')) return response(types)
      expect(parsed.searchParams.get('region')).toBe('eu-west-2')
      return response({ error: 'invalid region' }, 400)
    })
    const catalog = await createLiveLeasewebProvider({ ...options, families: { vps: { enabled: false }, cloud: { enabled: true } } }).syncCatalog()
    expect(catalog.offers).toEqual([])
  })

  it('throws on an inconclusive catalog read rather than returning a partial successful sync', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'temporary' }, 503))
    await expect(createLiveLeasewebProvider(options).syncCatalog()).rejects.toBeInstanceOf(ProviderRetryableError)
  })
})
