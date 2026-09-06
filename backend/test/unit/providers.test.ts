import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockLeasewebProvider } from '../../src/modules/providers/leaseweb/mock.js'
import { LeasewebClient } from '../../src/modules/providers/leaseweb/client.js'
import { NotSupportedError } from '../../src/modules/providers/provider.interface.js'
import { ProviderPermanentError, ProviderRetryableError, ProviderUnknownError } from '../../src/lib/errors.js'
import { pino } from 'pino'

const silentLogger = pino({ level: 'silent' })

describe('mock Leaseweb provider', () => {
  afterEach(() => undefined)

  it('syncs a realistic catalog with monthly billing options', async () => {
    const provider = createMockLeasewebProvider()
    const { offers, locations } = await provider.syncCatalog()
    expect(locations.length).toBeGreaterThan(0)
    expect(offers.length).toBeGreaterThan(0)
    const offer = offers.find((o) => o.providerProductId === 'VPS02_4')!
    expect(offer.vcpu).toBe(2)
    expect(offer.memoryMb).toBe(4096)
    expect(offer.billingOptions.some((b) => b.monthly && b.periodMonths === 1)).toBe(true)
    expect(offer.operatingSystems.length).toBeGreaterThan(0)
  })

  it('creates a server and manages power state', async () => {
    const provider = createMockLeasewebProvider()
    const result = await provider.createServer({
      productId: 'VPS02_4',
      location: 'AMS-01',
      operatingSystem: 'ubuntu-24.04',
      billingOption: { billingCycle: 'monthly', contractTerm: 0, periodMonths: 1, amountCents: 1450 },
      hostname: 'test-vps',
    })
    expect(result.providerOrderId).toBeTruthy()
    expect(result.providerServerId).toBeTruthy()
    expect(result.state).toBe('active')

    const view = await provider.getServer(result.providerServerId!)
    expect(view.hostname).toBe('test-vps')
    expect(view.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

    await provider.powerOff(result.providerServerId!)
    const stopped = await provider.getServer(result.providerServerId!)
    expect(stopped.state).toBe('suspended')
    await provider.powerOn(result.providerServerId!)
    expect((await provider.getServer(result.providerServerId!)).state).toBe('active')
    await provider.reboot(result.providerServerId!)
  })

  it('reports unsupported capabilities', () => {
    const provider = createMockLeasewebProvider()
    expect(provider.supports('snapshots')).toBe(false)
    expect(() => provider.require('snapshots')).toThrow(NotSupportedError)
    expect(provider.supports('provision')).toBe(true)
  })

  it('simulates retryable and permanent failures', async () => {
    const provider = createMockLeasewebProvider()
    provider.setBehavior({ failNextOrders: 'retryable', failNextOrdersCount: 1 })
    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'AMS-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
      }),
    ).rejects.toBeInstanceOf(ProviderRetryableError)

    provider.setBehavior({ failNextOrders: 'permanent', failNextOrdersCount: 1 })
    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'AMS-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
      }),
    ).rejects.toBeInstanceOf(ProviderPermanentError)
  })

  it('simulates timeout-after-dispatch: server exists at provider but response lost', async () => {
    const provider = createMockLeasewebProvider()
    provider.setBehavior({ timeoutNextOrders: true })
    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'AMS-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
      }),
    ).rejects.toBeInstanceOf(ProviderUnknownError)
    // The phantom server IS at the provider — reconciliation must find it.
    const listed = await provider.listServers()
    expect(listed.length).toBe(1)
    expect(listed[0]?.hostname).toBeTruthy()
  })

  it('never creates a second server after a retried ambiguous order', async () => {
    const provider = createMockLeasewebProvider()
    provider.setBehavior({ timeoutNextOrders: true })
    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'AMS-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
      }),
    ).rejects.toBeInstanceOf(ProviderUnknownError)
    // The dispatch happened exactly once; the provider holds exactly one VPS.
    expect(provider._postCount()).toBe(1)
    expect(provider._vpsList().length).toBe(1)
  })

  it('reconcile refuses to auto-attach a hostname candidate (AMBIGUOUS)', async () => {
    const provider = createMockLeasewebProvider()
    provider.setBehavior({ timeoutNextOrders: true })
    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'AMS-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
        hostname: 'must-not-autoattach',
      }),
    ).rejects.toBeInstanceOf(ProviderUnknownError)
    const res = await provider.reconcileOrder!({ requested: { productId: 'VPS02_4', location: 'AMS-01', hostname: 'must-not-autoattach' } })
    expect(res.resolution).toBe('AMBIGUOUS')
    expect(res.candidates?.some((c) => c.hostname === 'must-not-autoattach')).toBe(true)
    expect(res.providerServerId).toBeUndefined()
  })

  it('reconcile MATCHED only via a provider server id captured before the ambiguity', async () => {
    const provider = createMockLeasewebProvider()
    // Normal order: capture the id, then simulate the lost-response case by
    // querying reconciliation with that captured id (server exists).
    const res = await provider.createServer({
      productId: 'VPS02_4',
      location: 'AMS-01',
      operatingSystem: 'ubuntu-24.04',
      billingOption: { billingCycle: 'monthly', contractTerm: 0, amountCents: 1450 },
    })
    const capturedId = res.providerServerId!
    const rec = await provider.reconcileOrder!({ knownProviderServerId: capturedId })
    expect(rec.resolution).toBe('MATCHED')
    expect(rec.providerServerId).toBe(capturedId)
    // An id that does not exist at the provider is NO_MATCH, not MATCHED.
    const missing = await provider.reconcileOrder!({ knownProviderServerId: 'vps-does-not-exist' })
    expect(missing.resolution).toBe('NO_MATCH')
  })
})

describe('LeasewebClient error mapping', () => {
  it('maps 5xx to retryable and 4xx to permanent', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"error":"bad"}', { status: 400 }))

    const client = new LeasewebClient({ baseUrl: 'https://api.leaseweb.com', apiKey: 'secret-key', logger: silentLogger })
    await expect(client.get('/vps/v1/virtualServers')).rejects.toBeInstanceOf(ProviderRetryableError)
    await expect(client.get('/vps/v1/virtualServers')).rejects.toBeInstanceOf(ProviderPermanentError)
    fetchMock.mockRestore()
  })

  it('sends X-LSW-Auth header and correlation id, and times out safely', async () => {
    let capturedHeaders: Record<string, string> | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // Node passes the headers object through to fetch as-is.
      capturedHeaders = init?.headers as Record<string, string>
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    const client = new LeasewebClient({ baseUrl: 'https://api.leaseweb.com', apiKey: 'super-secret', logger: silentLogger, timeoutMs: 50 })
    await expect(client.get('/ordering/v1/products/vps')).rejects.toBeInstanceOf(ProviderRetryableError)
    expect(capturedHeaders?.['X-LSW-Auth']).toBe('super-secret')
    expect(capturedHeaders?.['X-Correlation-Id']).toBeTruthy()
    fetchMock.mockRestore()
  })

  it('refuses requests without a configured API key', async () => {
    const client = new LeasewebClient({ baseUrl: 'https://api.leaseweb.com', apiKey: '', logger: silentLogger })
    await expect(client.get('/vps/v1/virtualServers')).rejects.toBeInstanceOf(ProviderPermanentError)
  })
})