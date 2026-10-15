/**
 * Live-mode ordering safety guard.
 *
 * With LEASEWEB_MODE=live but LEASEWEB_ORDERING_ENABLED=false, any attempt to
 * place a paid VPS order must fail LOCALLY with a permanent safety error and
 * must never send an HTTP request to the provider.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { pino } from 'pino'
import { createLiveLeasewebProvider } from '../../src/modules/providers/leaseweb/live.js'
import { ProviderPermanentError } from '../../src/lib/errors.js'

const silentLogger = pino({ level: 'silent' })

let server: Server | null = null

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

async function startCountingServer(): Promise<{ baseUrl: string; hits: () => number }> {
  let count = 0
  server = createHttpServer((req, res) => {
    count++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.method === 'GET' ? { vpss: [], _metadata: { totalCount: 0 } } : { orderId: 'ord-should-never-happen' }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { baseUrl: `http://127.0.0.1:${address.port}`, hits: () => count }
}

describe('live mode ordering guard (LEASEWEB_ORDERING_ENABLED=false)', () => {
  it('refuses a paid order locally and issues ZERO provider HTTP POSTs', async () => {
    const { baseUrl, hits } = await startCountingServer()
    const provider = createLiveLeasewebProvider({
      baseUrl,
      enabled: true,
      displayName: 'Leaseweb',
      accounts: [{ id: 'primary', apiKey: 'test-key-that-must-never-leave-this-file', enabled: true, priority: 100, state: 'active', label: 'Primary' }],
      locations: ['FRA-01'],
      families: { vps: { enabled: true }, cloud: { enabled: false } },
      orderingEnabled: false,
      logger: silentLogger,
    })

    await expect(
      provider.createServer({
        productId: 'VPS02_4',
        location: 'FRA-01',
        operatingSystem: 'ubuntu-24.04',
        billingOption: { billingCycle: 'monthly', contractTerm: 0 },
        hostname: 'guard-test-vps',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ProviderPermanentError &&
        /ordering is disabled/i.test((err as Error).message) &&
        !(err as Error).message.includes('test-key-that-must-never-leave-this-file')
      )
    })

    expect(hits()).toBe(0)
  })

  it('read-only catalog calls are still allowed with ordering disabled', async () => {
    const { baseUrl } = await startCountingServer()
    const provider = createLiveLeasewebProvider({
      baseUrl,
      enabled: true,
      displayName: 'Leaseweb',
      accounts: [{ id: 'primary', apiKey: 'test-key', enabled: true, priority: 100, state: 'active', label: 'Primary' }],
      locations: ['FRA-01'],
      families: { vps: { enabled: true }, cloud: { enabled: false } },
      orderingEnabled: false,
      logger: silentLogger,
    })
    // Must resolve (GET path), not throw the ordering guard.
    const result = await provider.syncCatalog()
    expect(Array.isArray(result.offers)).toBe(true)
  })
})