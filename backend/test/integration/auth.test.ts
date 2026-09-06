import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTestContext, truncateAll, dbAvailable, testLogger } from '../helpers.js'
import { buildApp } from '../../src/app.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { syncProviderCatalog, enableAllOffersForSale } from '../../src/modules/catalog/service.js'
import { getProvider } from '../../src/modules/providers/registry.js'
import type { FastifyInstance } from 'fastify'

const skip = !dbAvailable

describe.skipIf(skip)('auth + permissions (integration)', () => {
  let app: FastifyInstance
  let ctx: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    await setFxRate(ctx.db, '620000', { note: 'test fixture' })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await ctx.close()
  })

  async function register(email: string, password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password },
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { data: { token: string } }).data.token
  }

  it('registers, logs in, and refreshes the session', async () => {
    const token = await register('alice@test.local', 'Alice123456!')
    expect(token.startsWith('cls_')).toBe(true)

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(200)
    expect((me.json() as { data: { email: string } }).data.email).toBe('alice@test.local')

    // Wrong password rejected
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'alice@test.local', password: 'wrong-password' },
    })
    expect(bad.statusCode).toBe(401)

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { token },
    })
    expect(refresh.statusCode).toBe(200)
    const newToken = (refresh.json() as { data: { token: string } }).data.token
    expect(newToken).not.toBe(token)
  })

  it('requires auth for protected routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/servers' })
    expect(res.statusCode).toBe(401)
  })

  it('one user cannot read or act on another user\'s server', async () => {
    // User A creates an offer + order (mocked provision handled separately).
    const aToken = await register('bob@test.local', 'Bob123456!')
    const bToken = await register('carol@test.local', 'Carol123456!')

    const catalog = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/leaseweb/catalog/sync',
      headers: { authorization: `Bearer ${aToken}` },
    })
    // Non-admin is forbidden from admin endpoints.
    expect(catalog.statusCode).toBe(403)

    // Admin sync (create a quick admin directly).
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'root@test.local', password: 'Root123456!' },
    })
    const adminToken = (adminRes.json() as { data: { token: string } }).data.token
    await ctx.db.execute('update users set role = \'admin\' where email = \'root@test.local\'')
    const sync = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/leaseweb/catalog/sync',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(sync.statusCode).toBe(200)

    // A creates a server via the wizard bridge.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${aToken}`, 'idempotency-key': 'perm-a-1' },
      payload: { name: 'a-vps', region: 'germany', plan: 'standard', os: 'ubuntu' },
    })
    expect(create.statusCode).toBe(201)
    const serverId = (create.json() as { data: { id: string } }).data.id

    // B cannot see A's server.
    const bList = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { authorization: `Bearer ${bToken}` } })
    const bItems = (bList.json() as { data: unknown[] }).data
    expect(bItems.find((s) => (s as { id: string }).id === serverId)).toBeUndefined()

    const bGet = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}`, headers: { authorization: `Bearer ${bToken}` } })
    expect(bGet.statusCode).toBe(404)
  })
})