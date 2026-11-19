import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { migrate } from '../../src/db/migrate.js'
import { settings, users } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

describe.skipIf(!dbAvailable)('legacy Super Admin migration', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>, app: FastifyInstance

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
  })
  afterAll(async () => { await app?.close(); await ctx?.close() })

  const requeueBackfill = () => ctx.db.update(settings).set({ value: 'pending' }).where(eq(settings.key, 'auth.legacy_super_admin_backfill'))

  it('leaves ambiguous owners alone, promotes the sole legacy admin once, and refreshes existing sessions', async () => {
    const password = 'Fixture-legacy-owner-123!'
    const owner = await registerUser(ctx.db, { email: 'legacy-owner@example.test', password })
    const other = await registerUser(ctx.db, { email: 'other-admin@example.test', password })
    const customer = await registerUser(ctx.db, { email: 'customer@example.test', password })
    for (const account of [owner, other]) await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, account.id))
    const session = await createSession(ctx.db, owner.id, {})
    const headers = { authorization: `Bearer ${session.token}` }
    const capabilities = () => app.inject({ url: '/api/admin/settings/capabilities', headers })
    await requeueBackfill()
    await migrate()
    expect((await capabilities()).json().data.allowed).toBe(false)
    await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, other.id))
    await migrate()
    expect((await capabilities()).json().data.allowed).toBe(false) // An ambiguous installation is never retried automatically.
    await requeueBackfill()
    await migrate()
    expect((await capabilities()).json().data).toMatchObject({ allowed: true, primaryIpv4Pricing: true, hetznerMargin: true })
    expect((await app.inject({ url: '/api/auth/me', headers })).json().data.role).toBe('super_admin')
    for (const endpoint of ['gateway', 'outbound', 'hetzner-margin', 'primary-ipv4-pricing/hetzner', 'logs']) {
      const result = await app.inject({ url: `/api/admin/settings/${endpoint}`, headers })
      expect(result.statusCode, endpoint + result.body).toBe(200)
    }
    await ctx.db.update(users).set({ status: 'active' }).where(eq(users.id, other.id))
    await migrate()
    expect((await ctx.db.query.users.findFirst({ where: t => eq(t.id, other.id) }))?.role).toBe('admin')
    expect((await ctx.db.query.users.findFirst({ where: t => eq(t.id, customer.id) }))?.role).toBe('user')
    const audit = await ctx.db.query.auditLogs.findMany({ where: t => eq(t.action, 'admin.super_admin_bootstrapped') })
    expect(audit).toMatchObject([{ targetId: owner.id, metadata: { before: 'admin', after: 'super_admin', source: 'legacy_role_migration' } }])
  })
})
