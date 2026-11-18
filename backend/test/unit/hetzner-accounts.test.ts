import { describe, expect, it } from 'vitest'
import { hetznerPrepaidMonth, offeredPeriods, retailBilling } from '../../src/modules/pricing/periods.js'
import type { HetznerConfig } from '../../src/config.js'
import type { ProviderOrderRequest } from '../../src/modules/providers/provider.interface.js'
import { ProviderPermanentError, ProviderUnknownError } from '../../src/lib/errors.js'
import { createHetznerProvider, operationLabel } from '../../src/modules/providers/hetzner/live.js'

type Json = Record<string, unknown>
interface Call { account: string; method: string; path: string; body?: Json }
const config: HetznerConfig = {
  enabled: true, displayName: 'Hetzner', baseUrl: 'https://provider.test/v1', orderingEnabled: true,
  accounts: [
    { id: 'second', enabled: true, state: 'active', priority: 200, label: 'Second', apiToken: 'fake-hetzner-second-token' },
    { id: 'first', enabled: true, state: 'active', priority: 100, label: 'First', apiToken: 'fake-hetzner-first-token' },
    { id: 'old', enabled: false, state: 'active', priority: 1, label: 'Old', apiToken: 'fake-hetzner-old-token' },
  ],
}
const order: ProviderOrderRequest = {
  productId: 'cx-test:EUR', location: 'fsn1', operatingSystem: '11', hostname: 'customer-server',
  clientReference: 'internal-operation-unique-123', billingOption: { billingCycle: 'hourly', amount: '0.0052' },
}
function server(id: number, labels: Json = {}): Json {
  return { id, name: 'customer-server', status: 'running', labels, server_type: { cores: 2, memory: 4, disk: 40 }, public_net: { ipv4: { ip: '192.0.2.4' }, ipv6: { ip: '2001:db8::/64' } } }
}
function mockApi(handler?: (call: Call) => Response | Json | Promise<Response | Json>, overrides: Record<string, Json> = {}): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const token = new Headers(init?.headers).get('authorization') ?? ''
    const account = config.accounts.find((candidate) => token === `Bearer ${candidate.apiToken}`)?.id ?? 'unknown'
    const call: Call = { account, method: init?.method ?? 'GET', path: url.pathname.replace('/v1', ''), ...(init?.body ? { body: JSON.parse(String(init.body)) as Json } : {}) }
    calls.push(call)
    let payload: Json | Response
    if (call.method === 'GET' && call.path === '/server_types') {
      payload = { server_types: [{
        id: 1, name: 'cx-test', architecture: 'x86', cores: 2, memory: 4, disk: 40,
        locations: [{ name: 'fsn1', available: true }],
        prices: [{ location: 'fsn1', price_hourly: { gross: '0.0044000000' }, price_monthly: { gross: '3.790000' }, included_traffic: 20_000_000_000_000,
          price_per_tb_traffic: { gross: '1.125' } }],
        credential_echo: 'fake-hetzner-first-token',
      }] }
    } else if (call.method === 'GET' && call.path === '/locations') payload = { locations: [{ name: 'fsn1', country: 'DE', city: 'Falkenstein' }] }
    else if (call.method === 'GET' && call.path === '/images') payload = { images: [
      { id: 11, name: 'ubuntu-24.04', description: 'Ubuntu 24.04', type: 'system', status: 'available', architecture: 'x86', os_flavor: 'ubuntu' },
      { id: 12, name: 'ubuntu-arm', type: 'system', status: 'available', architecture: 'arm' },
      { id: 13, name: 'old-image', type: 'system', status: 'available', architecture: 'x86', deprecated: '2025-01-01' },
      { id: 14, name: 'private-snapshot', type: 'snapshot', status: 'available', architecture: 'x86' },
    ] }
    else if (call.method === 'GET' && call.path === '/pricing') payload = { pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [{ location: 'fsn1', price_hourly: { gross: '0.0008' }, price_monthly: { gross: '0.6' } }] }] } }
    else payload = handler ? await handler(call) : { server: server(100), action: { id: 9, status: 'running' } }
    payload = overrides[call.path] ?? payload
    return payload instanceof Response ? payload : Response.json(payload)
  }
  return { fetcher, calls }
}

describe('Hetzner account routing and live catalog', () => {
  it.each([false, true])('handles the affected CAX11/Nuremberg ARM request when capacity is rejected=%s', async rejected => {
    const api = mockApi(() => rejected
      ? Response.json({ error: { code: 'resource_unavailable', message: 'fixture-secret-provider-message' } }, { status: 412 })
      : { server: server(167) }, {
      '/locations': { locations: [{ name: 'nbg1', country: 'DE', city: 'Nuremberg' }] },
      '/server_types': { server_types: [{ id: 167, name: 'cax11', architecture: 'arm', cores: 2, memory: 4, disk: 40,
        locations: [{ name: 'nbg1', available: true }], prices: [{ location: 'nbg1', price_hourly: { gross: '0.0044' } }] }] },
      '/images': { images: [{ id: 387894171, name: 'ubuntu-arm', type: 'system', status: 'available', architecture: 'arm' }] },
      '/pricing': { pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [{ location: 'nbg1', price_hourly: { gross: '0.0008' } }] }] } },
    })
    const provider = createHetznerProvider({ ...config, accounts: [config.accounts[1]!] }, { fetch: api.fetcher })
    const attempt = provider.createServer({ ...order, productId: 'cax11:EUR', location: 'nbg1', operatingSystem: '387894171' })
    if (rejected) {
      await expect(attempt).rejects.toMatchObject({ details: { httpStatus: 412, providerCode: 'resource_unavailable', definitiveRejection: true } })
      await expect(attempt).rejects.not.toThrow('fixture-secret-provider-message')
    } else expect(await attempt).toMatchObject({ providerServerId: 'first:167', state: 'active' })
    const posts = api.calls.filter(call => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ server_type: 'cax11', location: 'nbg1', image: 387894171 })
  })
  it('publishes only provider-priced available compatible images, including exact IPv4 cost', async () => {
    const api = mockApi()
    const provider = createHetznerProvider(config, { fetch: api.fetcher })
    const result = await provider.syncCatalog()
    expect(result.offers).toHaveLength(1)
    expect(result.offers[0]).toMatchObject({ category: 'cloud', providerProductId: 'cx-test:EUR', ipv4Count: 1, providerCurrency: 'EUR', providerPriceCents: null })
    expect(result.offers[0]?.billingOptions).toEqual([
      { billingCycle: 'hourly', label: 'Hourly (monthly cap)', amount: '0.0052' },
      { billingCycle: hetznerPrepaidMonth, label: 'Prepaid retail month', amount: '4.39', amountCents: 439 },
    ])
    expect(result.offers[0]?.operatingSystems.map((image) => image.id)).toEqual(['11'])
    expect(result.offers[0]?.raw).toMatchObject({ monthlyCapGross: '4.39', ipv4Included: true })
    expect(JSON.stringify(result)).not.toContain('fake-hetzner-first-token')
    expect(api.calls.some((call) => call.account === 'old')).toBe(false)
  })

  it('uses location-specific traffic and requires both caps for a prepaid month', async () => {
    const prices = [
      { location: 'fsn1', price_hourly: { gross: '0.0044' }, price_monthly: { gross: '3.79' }, included_traffic: 20e12, price_per_tb_traffic: { gross: '1.125' } },
      { location: 'ash', price_hourly: { gross: '0.0054' }, price_monthly: { gross: '4.79' }, included_traffic: 1e12, price_per_tb_traffic: { gross: '2.125' } },
      { location: 'sin', price_hourly: { gross: '0.0074' }, price_monthly: { gross: '6.79' }, included_traffic: 0.5e12 },
    ]
    const locations = prices.map(({ location: name }) => ({ name, available: true }))
    const api = mockApi(undefined, {
      '/locations': { locations },
      '/server_types': { server_types: [{ id: 1, name: 'cx-test', architecture: 'x86', cores: 2, memory: 4, disk: 40, locations, prices }] },
      '/pricing': { pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: prices.map(({ location }) => ({
        location, price_hourly: { gross: '0.0008' }, ...(location !== 'sin' && { price_monthly: { gross: '0.6' } }),
      })) }] } },
    })
    const { offers } = await createHetznerProvider(config, { fetch: api.fetcher }).syncCatalog()
    const [eu, us, asia] = offers
    expect(eu!.raw).toMatchObject({ trafficTariff: { location: 'fsn1', grossPerTb: '1.125', includedTrafficBytes: 20e12 } })
    expect(us!.raw).toMatchObject({ trafficTariff: { location: 'ash', grossPerTb: '2.125', includedTrafficBytes: 1e12 } })
    expect(retailBilling(us!.billingOptions, 'monthly').pricing.amountCents).toBe(539)
    expect(asia!.trafficGb).toBe(500)
    expect(asia!.raw).not.toHaveProperty('trafficTariff')
    expect(offeredPeriods(asia!.billingOptions)).toEqual(['hourly'])
  })

  it('uses exact fallback prices and preserves allowances across all six live locations', async () => {
    const codes = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin']
    const locations = codes.map(name => ({ name, available: true }))
    const types = ['cpx02', 'cpx12', 'cpx22'].map((name, index) => {
      const prices = codes.map(location => ({ location, price_hourly: { gross: '0.008' },
        included_traffic: (location === 'sin' ? [0.5, 1, 2][index]! : 20) * 2 ** 40 }))
      return { id: index + 1, name, architecture: 'x86', cores: 2, memory: 4, disk: 40, locations, prices }
    })
    const serverTypes = types.map(({ id, name }) => ({ id, name, prices: codes.map(location => ({
      location: { name: location }, price_monthly: { gross: ['4.990000000000', '9.49123456', '16.4900'][id - 1] },
      price_per_tb_traffic: { gross: location === 'sin' ? '7.4000000000000000' : '1.0000000000000000' },
    })) }))
    const api = mockApi(undefined, {
      '/locations': { locations },
      '/server_types': { server_types: types },
      '/pricing': { pricing: { currency: 'EUR', server_types: serverTypes, primary_ips: [{ type: 'ipv4',
        prices: codes.map(location => ({ location, price_hourly: { gross: '0.0008' }, price_monthly: { gross: '0.600000000' } })) }] } },
    })
    const { offers } = await createHetznerProvider(config, { fetch: api.fetcher }).syncCatalog()
    expect(offers).toHaveLength(18)
    for (const offer of offers) {
      const index = types.findIndex(type => type.name === offer.name)
      expect(offeredPeriods(offer.billingOptions)).toEqual(['hourly', 'monthly'])
      expect(retailBilling(offer.billingOptions, 'monthly').native.amount).toBe(['5.59', '10.09123456', '17.09'][index])
      expect(offer.raw).toMatchObject({ trafficTariff: {
        grossPerTb: offer.location === 'sin' ? '7.4' : '1',
        includedTrafficBytes: (offer.location === 'sin' ? [0.5, 1, 2][index]! : 20) * 2 ** 40,
      } })
    }
    // A price from another currency, region, or server type cannot back this offer.
    serverTypes[0]!.prices[0] = { ...serverTypes[0]!.prices[0]!, location: { name: 'other' } }
    Object.assign(serverTypes[1]!.prices[0]!, { currency: 'USD' })
    serverTypes[2]!.name = 'other-type'
    const mismatched = (await createHetznerProvider(config, { fetch: api.fetcher }).syncCatalog()).offers.filter(offer => offer.location === 'fsn1')
    for (const offer of mismatched) {
      expect(offeredPeriods(offer.billingOptions)).toEqual(['hourly'])
      const expectedReason = { cpx02: 'server_location_mismatch', cpx12: 'server_currency_mismatch', cpx22: 'server_monthly_missing' }
      expect(offer.raw).toMatchObject({ includedTrafficBytes: 20 * 2 ** 40, monthlyUnavailableReasons: [expectedReason[offer.name as keyof typeof expectedReason]] })
      expect(offer.raw).not.toHaveProperty('trafficTariff')
    }
  })

  it('provisions a prepaid month using its exact cap and rejects a mismatched quote without dispatch', async () => {
    const api = mockApi()
    const provider = createHetznerProvider(config, { fetch: api.fetcher })
    const billingOption = { billingCycle: hetznerPrepaidMonth, amount: '4.39' }
    await expect(provider.createServer({ ...order, billingOption: { ...billingOption, amount: '4.38' } })).rejects.toThrow(/exact price/)
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0)
    await expect(provider.createServer({ ...order, billingOption })).resolves.toMatchObject({ state: 'active' })
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('fails closed for unavailable locations, missing IPv4 pricing and empty compatible images', async () => {
    const overrides: Array<Record<string, Json>> = [
      { '/server_types': { server_types: [{ id: 1, name: 'cx-test', architecture: 'x86', cores: 2, memory: 4, disk: 40, locations: [{ name: 'fsn1', available: false }] }] } },
      { '/pricing': { pricing: { currency: 'EUR' } } },
      { '/images': { images: [] } },
    ]
    for (const override of overrides) {
      const api = mockApi(undefined, override)
      const result = await createHetznerProvider(config, { fetch: api.fetcher }).syncCatalog()
      expect(result.offers).toEqual([])
    }
  })

  it('redacts reflected credentials and never forwards unknown response fields', async () => {
    const api = mockApi(() => ({ server: { ...server(7), name: 'host-fake-hetzner-old-token', credentials: 'fake-hetzner-old-token' } }))
    const view = await createHetznerProvider(config, { fetch: api.fetcher }).getServer('old:7')
    expect(view.hostname).toBe('host-***REDACTED***')
    expect(JSON.stringify(view)).not.toContain('fake-hetzner-old-token')
    expect(view.metadata).not.toHaveProperty('credentials')
  })

  it('uses priority order and fails over only after a definitive capacity refusal', async () => {
    const api = mockApi((call) => call.account === 'first'
      ? Response.json({ error: { code: 'resource_limit_exceeded', message: 'fake-hetzner-first-token' } }, { status: 403 })
      : { server: server(101) })
    const result = await createHetznerProvider(config, { fetch: api.fetcher }).createServer(order)
    expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.account)).toEqual(['first', 'second'])
    expect(result.providerServerId).toBe('second:101')
    expect(result.providerOrderId).toBe('second:101')
    const dispatch = api.calls.find((call) => call.method === 'POST')
    expect(dispatch?.body).toMatchObject({ server_type: 'cx-test', image: 11, public_net: { enable_ipv4: true, enable_ipv6: true }, labels: { 'tofan-operation': operationLabel(order.clientReference!) } })
    expect(JSON.stringify(result)).not.toContain('fake-hetzner-first-token')
  })

  it.each([500, 429, 408, 400])('never dispatches to another account for ambiguous HTTP %s', async (status) => {
    const api = mockApi(() => Response.json({ error: { code: 'unrecognized', message: 'fake-hetzner-first-token' } }, { status }))
    await expect(createHetznerProvider(config, { fetch: api.fetcher }).createServer(order)).rejects.toBeInstanceOf(ProviderUnknownError)
    expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.account)).toEqual(['first'])
  })

  it('does not fail over after transport ambiguity or a successful response missing its server id', async () => {
    const transport = mockApi(() => { throw new Error('fake-hetzner-first-token') })
    await expect(createHetznerProvider(config, { fetch: transport.fetcher }).createServer(order)).rejects.toBeInstanceOf(ProviderUnknownError)
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    const missing = mockApi(() => ({ action: { id: 3 } }))
    await expect(createHetznerProvider(config, { fetch: missing.fetcher }).createServer(order)).rejects.toBeInstanceOf(ProviderUnknownError)
    expect(missing.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('never treats an authentication failure as account capacity', async () => {
    const api = mockApi(() => Response.json({ error: { code: 'forbidden', message: 'fake-hetzner-first-token' } }, { status: 403 }))
    await expect(createHetznerProvider(config, { fetch: api.fetcher }).createServer(order)).rejects.toBeInstanceOf(ProviderPermanentError)
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('routes management to the disabled original account, never a new active account', async () => {
    const api = mockApi(() => ({ server: server(7), action: { id: 8, status: 'running' } }))
    const provider = createHetznerProvider(config, { fetch: api.fetcher })
    expect((await provider.getServer('old:7')).providerServerId).toBe('old:7')
    await provider.powerOn('old:7')
    expect(api.calls.map((call) => call.account)).toEqual(['old', 'old'])
    await expect(provider.getServer('missing:7')).rejects.toThrow(/ownership is unknown/)
    expect(api.calls).toHaveLength(2)
  })

  it('matches only the exact operation label across every account, not a matching hostname', async () => {
    const label = operationLabel(order.clientReference!)
    const api = mockApi((call) => ({ servers: [server(call.account === 'old' ? 12 : 10, call.account === 'old' ? { 'tofan-operation': label } : {})] }))
    const result = await createHetznerProvider(config, { fetch: api.fetcher }).reconcileOrder!({ requested: { clientReference: order.clientReference, hostname: order.hostname } })
    expect(result.resolution).toBe('MATCHED')
    expect(result.providerServerId).toBe('old:12')
    expect(api.calls.map((call) => call.account)).toEqual(['old', 'first', 'second'])
  })

  it('keeps absent labels, duplicate labels and unreadable inventory ambiguous', async () => {
    const absent = mockApi(() => ({ servers: [server(1)] }))
    expect((await createHetznerProvider(config, { fetch: absent.fetcher }).reconcileOrder!({ requested: { clientReference: order.clientReference, hostname: order.hostname } })).resolution).toBe('AMBIGUOUS')
    const duplicates = mockApi(() => ({ servers: [server(1, { 'tofan-operation': operationLabel(order.clientReference!) })] }))
    expect((await createHetznerProvider(config, { fetch: duplicates.fetcher }).reconcileOrder!({ requested: { clientReference: order.clientReference } })).resolution).toBe('AMBIGUOUS')
    const unavailable = mockApi(() => Response.json({}, { status: 500 }))
    expect((await createHetznerProvider(config, { fetch: unavailable.fetcher }).reconcileOrder!({ knownProviderServerId: 'old:7' })).resolution).toBe('AMBIGUOUS')
  })

  it('refuses dispatch while ordering is disabled', async () => {
    const api = mockApi()
    await expect(createHetznerProvider({ ...config, orderingEnabled: false }, { fetch: api.fetcher }).createServer(order)).rejects.toThrow(/ordering is disabled/)
    expect(api.calls).toHaveLength(0)
  })
})
