import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { AppError } from '../../src/lib/errors.js'
import type { SessionUser } from '../../src/modules/auth/service.js'
import { assertUnifiedCutoverReady, decryptPlatformToken, encryptPlatformToken, installPlatformIntegration, platformRequest, requireToman } from '../../src/modules/integration/platform.js'

const userId = 'b4f1fa75-2811-4d7e-9038-41ef8fcc8a70'
const platformUserId = 'e4cf75fe-28b3-43ed-887b-cf9beae23d25'

beforeEach(() => { loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'http://127.0.0.1:9000', AUTH_SECRET: 'fixture-only-long-encryption-key' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function harness(linked = true) {
  const app = Fastify()
  const findFirst = vi.fn().mockResolvedValue(linked ? { platformUserId, tokenEncrypted: encryptPlatformToken('cpt_fixture', userId) } : undefined)
  const ctx = { db: { query: { platformLinks: { findFirst } } } } as unknown as AppContext
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
  app.post('/api/v1/servers', legacy)
  await app.ready()
  return { app, legacy, findFirst }
}

describe('platform bridge', () => {
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
