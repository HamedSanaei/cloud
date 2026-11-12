import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../../src/app.js'
import { users } from '../../src/db/schema.js'
import { registerUser, login } from '../../src/modules/auth/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

describe.skipIf(!dbAvailable)('admin console / site database (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let app: FastifyInstance
  let adminToken: string
  let ordinaryToken: string
  let adminId: string

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    const admin = await registerUser(ctx.db, { email: 'console-admin@test.local', password: 'TestPass123456!' })
    const user = await registerUser(ctx.db, { email: 'console-user@test.local', password: 'TestPass123456!' })
    adminId = admin.id
    await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 1_230_000, { type: 'manual_credit', description: 'test credit' })
    const loginA = await login(ctx.db, { email: admin.email, password: 'TestPass123456!' }, {})
    const loginU = await login(ctx.db, { email: user.email, password: 'TestPass123456!' }, {})
    adminToken = loginA.token
    ordinaryToken = loginU.token
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await ctx?.close()
  })

  it('rejects unauthenticated and ordinary users', async () => {
    const missing = await app.inject('/api/admin/console/users')
    expect(missing.statusCode).toBe(401)
    const ordinary = await app.inject({ url: '/api/admin/console/users', headers: { authorization: `Bearer ${ordinaryToken}` } })
    expect(ordinary.statusCode).toBe(403)
    const hetzner = await app.inject({ url: '/api/admin/console/hetzner/inventory', headers: { authorization: `Bearer ${ordinaryToken}` } })
    expect(hetzner.statusCode).toBe(403)
    expect((await app.inject('/api/admin/console/hetzner/inventory')).statusCode).toBe(401)
  })

  it('returns website-owned wallet balances without protected secrets', async () => {
    const headers = { authorization: `Bearer ${adminToken}` }
    const overview = await app.inject({ url: '/api/admin/console/overview', headers })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().data.source).toBe('website')
    const usersResponse = await app.inject({ url: '/api/admin/console/users?search=console-user', headers })
    expect(usersResponse.statusCode).toBe(200)
    expect(usersResponse.json().data.items).toHaveLength(1)
    expect(usersResponse.json().data.items[0].balanceRial).toBe(1_230_000)
    expect(usersResponse.json().data.items[0].balanceToman).toBe(123_000)
    const details = await app.inject({ url: `/api/admin/console/users/${usersResponse.json().data.items[0].id}`, headers })
    expect(details.statusCode).toBe(200)
    expect(details.json().data.transactions).toHaveLength(1)
    expect(JSON.stringify(details.json())).not.toMatch(/passwordHash|totpSecret|tokenEncrypted/)
    const own = await app.inject({ url: `/api/admin/console/users/${adminId}`, headers })
    expect(own.statusCode).toBe(200)
  })
})
