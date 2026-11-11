import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { AppContext } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import type { SessionUser } from '../../src/modules/auth/service.js'
import { assertSiteAuthorityReady, effectiveAuthority } from '../../src/modules/integration/authority.js'
import { installPlatformIntegration } from '../../src/modules/integration/platform.js'
import { registerAdminConsoleRoutes } from '../../src/modules/admin/console.js'

const admin = { id: '18436d6f-33c8-4964-8a39-479c68232065', email: 'admin@example.test', role: 'admin', status: 'active', sessionId: 'sid' } as SessionUser

afterEach(() => {
  vi.restoreAllMocks()
  loadConfig({ NODE_ENV: 'test' })
})

describe('site authority source-of-truth', () => {
  it('preserves the prior platform default until explicitly switched', () => {
    expect(effectiveAuthority(loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'https://example.test' }))).toBe('platform')
    expect(effectiveAuthority(loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: '', DATA_AUTHORITY: 'site' }))).toBe('site')
    expect(effectiveAuthority(loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'https://example.test', DATA_AUTHORITY: 'site' }))).toBe('site')
    expect(effectiveAuthority(loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: 'https://example.test', DATA_AUTHORITY: 'platform' }))).toBe('platform')
    expect(() => loadConfig({ NODE_ENV: 'test', PLATFORM_API_URL: '', DATA_AUTHORITY: 'platform' })).toThrow('requires PLATFORM_API_URL')
  })

  it('accepts an empty site even if a legacy platform URL remains configured', async () => {
    loadConfig({ NODE_ENV: 'test', DATA_AUTHORITY: 'site', PLATFORM_API_URL: 'https://example.test' })
    const findLink = vi.fn().mockResolvedValue(undefined)
    const receipt = vi.fn().mockResolvedValue(undefined)
    const db = { query: { platformLinks: { findFirst: findLink }, auditLogs: { findFirst: receipt } } } as unknown as AppContext['db']
    await expect(assertSiteAuthorityReady(db)).resolves.toBeUndefined()
    expect(findLink).toHaveBeenCalledOnce()
    expect(receipt).not.toHaveBeenCalled()
  })

  it('fails closed if a Python account binding could still write data', async () => {
    loadConfig({ NODE_ENV: 'test', DATA_AUTHORITY: 'site' })
    const db = {
      query: { platformLinks: { findFirst: vi.fn().mockResolvedValue({ userId: admin.id }) } },
    } as unknown as AppContext['db']
    await expect(assertSiteAuthorityReady(db)).rejects.toThrow('stale Python platform links exist')
  })

})

describe('read-only admin routes', () => {
  async function server(role: 'user' | 'admin', authority: 'site' | 'platform') {
    loadConfig({ NODE_ENV: 'test', DATA_AUTHORITY: authority, PLATFORM_API_URL: 'https://example.test' })
    const db = { query: { users: { findFirst: vi.fn() } }, select: vi.fn() }
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('preHandler', async request => { request.user = { ...admin, role } })
    app.setErrorHandler((error, _, reply) => {
      const caught = error as Error & { status?: number; statusCode?: number }
      return reply.code(caught.status ?? caught.statusCode ?? 500).send({ message: caught.message })
    })
    await app.register(registerAdminConsoleRoutes, { prefix: '/admin/console', ctx: { db } as unknown as AppContext })
    await app.ready()
    return app
  }
  it('blocks ordinary users before touching private data', async () => {
    const app = await server('user', 'site')
    const response = await app.inject('/admin/console/users')
    expect(response.statusCode).toBe(403)
    await app.close()
  })
  it('does not show stale site ledger while Python remains canonical', async () => {
    const app = await server('admin', 'platform')
    const response = await app.inject('/admin/console/users')
    expect(response.statusCode).toBe(409)
    await app.close()
  })
  it('does not expose mutating admin console methods', async () => {
    const app = await server('admin', 'site')
    const response = await app.inject({ method: 'POST', url: '/admin/console/users', payload: {} })
    expect(response.statusCode).toBe(404)
    await app.close()
  })
})

describe('site authority never delegates wallet data', () => {
  it('keeps the existing website wallet endpoint active and makes no Python request', async () => {
    loadConfig({ NODE_ENV: 'test', DATA_AUTHORITY: 'site', PLATFORM_API_URL: 'https://example.test' })
    const fetchSpy = vi.fn(() => { throw new Error('Unexpected platform access') })
    vi.stubGlobal('fetch', fetchSpy)
    const app = Fastify()
    app.decorateRequest('user', null)
    app.addHook('preHandler', async request => {
      request.user = { ...admin, role: 'user' }
    })
    installPlatformIntegration(app, { db: {} } as unknown as AppContext)
    app.get('/api/wallets', async () => ({ data: [{ id: 'site-wallet', balanceRial: 7000 }] }))
    await app.ready()
    const response = await app.inject('/api/wallets')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [{ id: 'site-wallet', balanceRial: 7000 }] })
    expect(fetchSpy).not.toHaveBeenCalled()
    await app.close()
  })
})
