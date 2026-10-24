import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { AppError } from '../../src/lib/errors.js'
import type { SessionUser } from '../../src/modules/auth/service.js'
import { assertPlatformCompatibility, assertUnifiedCutoverReady, decryptPlatformToken, encryptPlatformToken, installPlatformIntegration, platformRequest, requireToman, REQUIRED_PLATFORM_FEATURES } from '../../src/modules/integration/platform.js'
import { storefrontProjection } from '../../src/modules/integration/storefront.js'
import { serverProjection } from '../../src/modules/integration/platform.js'

const userId = 'b4f1fa75-2811-4d7e-9038-41ef8fcc8a70'
const platformUserId = 'e4cf75fe-28b3-43ed-887b-cf9beae23d25'

beforeEach(() => { loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'http://127.0.0.1:9000', AUTH_SECRET: 'fixture-only-long-encryption-key' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function harness(linked = true) {
  const app = Fastify()
  const findFirst = vi.fn().mockResolvedValue(linked ? { platformUserId, tokenEncrypted: encryptPlatformToken('cpt_fixture', userId) } : undefined)
  const updateWhere = vi.fn().mockResolvedValue(undefined)
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set: updateSet })
  const ctx = { db: { query: { platformLinks: { findFirst } }, update } } as unknown as AppContext
  app.decorateRequest('user', null)
  app.addHook('preHandler', async request => { request.user = { id: userId, role: 'user' } as SessionUser })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ code: error.code })
    return reply.status(500).send({ code: 'unexpected' })
  })
  installPlatformIntegration(app, ctx)
  const legacy = vi.fn().mockResolvedValue({ legacy: true })
  app.post('/api/wallets', legacy)
  app.get('/api/wallets', legacy)
  app.get('/api/servers', legacy)
  app.get('/api/catalog/storefront', legacy)
  app.get('/api/invoices', legacy)
  app.get('/api/charge-requests', legacy)
  app.get('/api/wallets/transactions', legacy)
  app.post('/api/v1/servers', legacy)
  await app.ready()
  return { app, legacy, findFirst, update, updateSet }
}

describe('platform bridge', () => {
  it('uses only the canonical platform UUID for delegated server identity', () => {
    const serverId = 'f07b9500-414e-4000-8000-000000000002'
    const projected = serverProjection({ server_id: serverId, state: 'running', display_name: 'leaseweb-test' })
    expect(projected.id).toBe(serverId)
    expect(projected.platformServerId).toBe(serverId)
    expect(projected.power.canPowerOn).toBe(false)
    expect(() => serverProjection({ server_id: '12717238', state: 'running' })).toThrow()
  })

  it('projects delegated inventory without calling a local server or financial writer', async () => {
    const serverId = 'f07b9500-414e-4000-8000-000000000002'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ server_id: serverId, state: 'running', display_name: 'leaseweb-test' }] }), { headers: { 'X-Platform-Contract': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, legacy, update } = await harness()
    const response = await app.inject('/api/servers')
    expect(response.statusCode).toBe(200)
    expect(response.json().data[0]).toMatchObject({ id: serverId, platformServerId: serverId })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:9000/v1/console/servers')
    expect(fetchMock.mock.calls[0]![1].method).toBe('GET')
    expect(legacy).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })

  it('never elevates a linked caller when forwarding a delegation request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'forbidden', message: 'superadmin required' } }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, update } = await harness()
    const path = `/api/platform/admin/servers/${userId}/delegations/${platformUserId}`
    expect((await app.inject({ method: 'POST', url: path, headers: { 'idempotency-key': 'fixture-key' }, payload: { operations: ['view'], reason: 'Approved access' } })).statusCode).toBe(403)
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('Bearer cpt_fixture')
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })
  const contract = { version: '1', environment: 'test', walletCurrency: 'IRT', displayCurrency: 'IRT', headerIdentityEnabled: false, usdUsdtParity: '1', usdtSettlementEnabled: true, confirmationSigningConfigured: true, features: [...REQUIRED_PLATFORM_FEATURES] }
  function compatibilityServer(features: string[] | undefined, probeStatus = 401) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/health/ready')) return new Response(JSON.stringify({ status: 'ok' }))
      if (String(url).endsWith('/link/contract')) return new Response(JSON.stringify({ data: { ...contract, features } }), { headers: { 'X-Platform-Contract': '1' } })
      return new Response(JSON.stringify({ error: { code: probeStatus === 401 ? 'unauthorized' : 'not_found' } }), { status: probeStatus, headers: { 'X-Platform-Contract': '1' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  it('refuses the old healthy platform when new website capabilities are missing', async () => {
    compatibilityServer(undefined)
    await expect(assertPlatformCompatibility()).rejects.toMatchObject({ code: 'platform_features_missing' })
  })
  it('refuses a falsely advertised capability whose endpoint is absent', async () => {
    compatibilityServer([...REQUIRED_PLATFORM_FEATURES], 404)
    await expect(assertPlatformCompatibility()).rejects.toMatchObject({ code: 'platform_feature_probe_failed' })
  })
  it('refuses a capability endpoint which accepts unauthenticated requests', async () => {
    compatibilityServer([...REQUIRED_PLATFORM_FEATURES], 200)
    await expect(assertPlatformCompatibility()).rejects.toMatchObject({ code: 'platform_feature_probe_failed' })
  })
  it('requires both feature versions and authenticated endpoints, without mutating real accounts', async () => {
    const fetchMock = compatibilityServer([...REQUIRED_PLATFORM_FEATURES])
    await expect(assertPlatformCompatibility()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const revoke = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/link/revoke'))!
    const options = (revoke as unknown as [string, RequestInit])[1]
    expect(options.method).toBe('POST')
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer ')
    expect(options.body).toBe('{}')
    const delegation = fetchMock.mock.calls.find(call => String(call[0]).includes('/delegations/'))! as unknown as [string, RequestInit]
    expect((delegation[1].headers as Record<string, string>).authorization).toBe('Bearer ')
    expect(JSON.parse(String(delegation[1].body)).operations).toEqual(['view'])
  })
  it('preserves native pricing and only projects real supported billing periods', () => {
    const row = { id: 'offer', name: 'Plan', provider: 'hetzner', location: 'fsn1', billingModel: 'hourly', priceMinor: 4, currency: 'USD', displayCurrency: 'IRT', displayPriceMinor: 1200, cpu: 2, ramGb: 4, diskGb: 40 }
    const catalog = storefrontProjection([row, { ...row, id: 'no-fx', displayPriceMinor: null }, { ...row, id: 'unknown', billingModel: 'unknown' }, { ...row, id: 'wrong-currency', displayCurrency: 'USD' }])
    expect(catalog.offers).toHaveLength(1)
    expect(catalog.offers[0]).toMatchObject({ canonicalPricing: { expectedMinor: 4, expectedCurrency: 'USD' }, prices: [{ period: 'hourly', totalRial: 12000 }] })
    expect(catalog.datacenters[0]?.locations).toEqual([{ code: 'fsn1', country: null, city: null }])
    expect(catalog.datacenters[0]?.billingPeriods).toEqual(['hourly'])
  })

  it('reaches the canonical catalog through the original storefront endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { headers: { 'X-Platform-Contract': '1' } })))
    const { app, legacy } = await harness()
    const response = await app.inject('/api/catalog/storefront')
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({ source: 'platform', datacenters: [], offers: [] })
    expect(legacy).not.toHaveBeenCalled()
    await app.close()
  })

  it('revokes remotely before erasing credentials, while retaining the identity binding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { revoked: true } }), { headers: { 'X-Platform-Contract': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, updateSet, update } = await harness()
    expect((await app.inject({ method: 'POST', url: '/api/integration/disconnect', payload: {} })).statusCode).toBe(200)
    expect(String(fetchMock.mock.calls[0]![0]).endsWith('/v1/console/link/revoke')).toBe(true)
    expect(fetchMock.mock.calls[0]![1].headers['idempotency-key']).toBeTruthy()
    expect(update).toHaveBeenCalledOnce()
    expect(updateSet).toHaveBeenCalledWith({ tokenEncrypted: '' })
    await app.close()
  })

  it('does not claim revoke succeeded or erase credentials when the authority is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { app, update } = await harness()
    expect((await app.inject({ method: 'POST', url: '/api/integration/disconnect', payload: {} })).statusCode).toBe(502)
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not erase credentials when the authority did not confirm revocation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { revoked: false } }), { headers: { 'X-Platform-Contract': '1' } })))
    const { app, update } = await harness()
    expect((await app.inject({ method: 'POST', url: '/api/integration/disconnect', payload: {} })).statusCode).toBe(502)
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })

  it('preserves historic foreign ledger formatting even when the current wallet is IRT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { balance: { currency: 'IRT', balance_minor: 1000 }, history: { items: [{ entry_id: 'entry', amount_minor: 500, currency: 'USD', formatted: '+5.00 USD', description: 'historic', entry_type: 'deposit', created_at: '2026-01-01T00:00:00Z' }] } } }), { headers: { 'X-Platform-Contract': '1' } })))
    const { app } = await harness()
    const response = await app.inject('/api/wallets/transactions')
    expect(response.statusCode).toBe(200)
    expect(response.json().data[0]).toMatchObject({ amount: 500, formattedAmount: '+5.00 USD', wallet: 'مشترک تلگرام و سایت' })
    await app.close()
  })

  it('refuses a toman-labelled recharge if the canonical wallet currency drifted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { balance: { currency: 'USD', balance_minor: 500 } } }), { headers: { 'X-Platform-Contract': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { app } = await harness()
    const response = await app.inject({ method: 'POST', url: '/api/platform/recharge', payload: { amountMinor: 1000, gateway: 'fixture' }, headers: { 'idempotency-key': 'fixture-idempotency' } })
    expect(response.statusCode).toBe(409)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]![0]).endsWith('/wallet')).toBe(true)
    await app.close()
  })

  it('never turns wallet ledger rows into fabricated invoices', async () => {
    const { app } = await harness()
    const response = await app.inject('/api/invoices')
    expect(response.statusCode).toBe(501)
    expect(response.json().code).toBe('invoices_unavailable')
    await app.close()
  })
  it('encrypts per-user, authenticates ciphertext and uses randomized envelopes', () => {
    const encrypted = encryptPlatformToken('cpt_fixture', userId)
    expect(encrypted).not.toContain('cpt_fixture')
    expect(encryptPlatformToken('cpt_fixture', userId)).not.toEqual(encrypted)
    expect(decryptPlatformToken(encrypted, userId)).toBe('cpt_fixture')
    expect(() => decryptPlatformToken(encrypted, platformUserId)).toThrow()
    expect(() => decryptPlatformToken('bad.envelope.data', userId)).toThrow()
  })

  it('never converts a foreign currency or imprecise integer to toman', () => {
    expect(requireToman({ currency: 'IRT', balance_minor: 12345 })).toBe(12345)
    expect(() => requireToman({ currency: 'EUR', balance_minor: 12345 })).toThrow()
    expect(() => requireToman({ currency: 'IRT', balance_minor: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
  })

  it('blocks legacy economic mutations on both API prefixes', async () => {
    const { app, legacy } = await harness()
    for (const url of ['/api/wallets', '/api/v1/servers', '/api/%77allets']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(409)
    }
    expect(legacy).not.toHaveBeenCalled()
    await app.close()
  })

  it('fails closed before forwarding for unlinked accounts or missing idempotency key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app } = await harness(false)
    expect((await app.inject('/api/platform/wallet')).statusCode).toBe(409)
    await app.close()
    const linked = await harness()
    expect((await linked.app.inject({ method: 'POST', url: '/api/platform/recharge', payload: {} })).statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    await linked.app.close()
  })

  it('forwards only allowlisted routes using the server-side linked identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { balance: 123 } }), { headers: { 'X-Platform-Contract': '1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { app } = await harness()
    const response = await app.inject('/api/v1/platform/wallet')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:9000/v1/console/wallet')
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('Bearer cpt_fixture')
    expect((await app.inject('/api/platform/../../admin')).statusCode).not.toBe(200)
    expect((await app.inject('/api/platform/tokens')).statusCode).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('preserves the canonical error status without exposing transport diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'forbidden', message: 'not allowed' } }), { status: 403 })))
    await expect(platformRequest('cpt_fixture', '/wallet')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private transport secret')))
    await expect(platformRequest('cpt_fixture', '/wallet')).rejects.toMatchObject({ status: 502, code: 'platform_unavailable' })
  })

  it('rejects origins with credentials or a non-origin base path', async () => {
    loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'http://fixture:secret@127.0.0.1/private' })
    await expect(platformRequest('cpt_fixture', '/wallet')).rejects.toMatchObject({ status: 503 })
  })

  it('refuses cutover with a residual local balance or live contract', async () => {
    const select = vi.fn().mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'legacy' }]) }) }) })
    await expect(assertUnifiedCutoverReady({ select } as unknown as AppContext['db'])).rejects.toThrow('cutover refused')
    expect(select).toHaveBeenCalledTimes(6)
  })
})
