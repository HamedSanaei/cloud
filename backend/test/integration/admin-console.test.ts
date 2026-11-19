import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../../src/app.js'
import { invoices, notifications, orders, providerOperations, servers, sessions, users, walletTransactions } from '../../src/db/schema.js'
import { registerUser, login, createSession } from '../../src/modules/auth/service.js'
import { applyWalletTransaction, ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
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

  it('blocks access and erases only eligible customer data while retaining financial evidence', async () => {
    const customer = await registerUser(ctx.db, { email: 'erasable@test.local', password: 'TestPass123456!', firstName: 'Customer' })
    const session = await createSession(ctx.db, customer.id, {})
    const wallet = await ensureDefaultWallet(ctx.db, customer.id)
    const headers = { authorization: `Bearer ${adminToken}` }
    const submit = (id: string, action: string, confirm = id) => app.inject({ method: 'POST',
      url: `/api/admin/console/users/${id}/account-action`, headers, payload: { action, confirm, reason: 'fixture case' } })
    expect((await submit(customer.id, 'block')).statusCode).toBe(403)
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, adminId))
    try {
      expect((await submit(customer.id, 'block', adminId)).statusCode).toBe(409)
      expect((await submit(adminId, 'delete_data')).statusCode).toBe(403)
      await ctx.db.insert(notifications).values({ userId: customer.id, title: 'fixture' })
      await creditWallet(ctx.db, customer.id, wallet.id, 100, { type: 'manual_credit' })
      expect((await submit(customer.id, 'delete_data')).statusCode).toBe(409)
      expect((await submit(customer.id, 'block')).statusCode).toBe(200)
      expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${session.token}` } })).statusCode).toBe(401)
      expect((await ctx.db.query.sessions.findFirst({ where: t => eq(t.id, session.sessionId) }))?.revokedAt).toBeTruthy()
      expect((await ctx.db.query.users.findFirst({ where: t => eq(t.id, customer.id) }))?.firstName).toBe('Customer')
      await applyWalletTransaction(ctx.db, customer.id, wallet.id, { type: 'manual_debit', amountRial: 100 })
      expect((await submit(customer.id, 'delete_data')).statusCode).toBe(200)
      const detail = (await app.inject({ url: `/api/admin/console/users/${customer.id}`, headers })).json().data
      expect(detail.user).toMatchObject({ email: '', firstName: null, status: 'disabled', dataDeleted: true })
      expect(detail.transactions).toHaveLength(2)
      expect(await ctx.db.query.notifications.findFirst({ where: t => eq(t.userId, customer.id) })).toBeUndefined()
    } finally { await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, adminId)) }
  })

  it('reports ledger totals, independent service status and read-only reconciliation', async () => {
    const customer = await registerUser(ctx.db, { email: 'overview@test.local', password: 'TestPass123456!' })
    const wallet = await ensureDefaultWallet(ctx.db, customer.id)
    const offer = { userId: customer.id, walletId: wallet.id, provider: 'hetzner', providerProductId: 'fixture', providerLocation: 'hel1', hostname: 'fixture', operatingSystem: 'Linux', paidAt: new Date() }
    const [active, running, failed, refunded] = await ctx.db.insert(orders).values([
      { ...offer, orderNumber: 'OV-A', status: 'active', totalRial: 161000 },
      { ...offer, orderNumber: 'OV-B', status: 'active', totalRial: 10000 },
      { ...offer, orderNumber: 'OV-F', status: 'failed', totalRial: 39000 },
      { ...offer, orderNumber: 'OV-R', status: 'refunded', totalRial: 5000 },
    ]).returning()
    const server = { ...offer, vcpu: 2, memoryMb: 2048, diskGb: 20 }
    await ctx.db.insert(servers).values([
      { ...server, orderId: active!.id, status: 'active', terminatedAt: new Date() },
      { ...server, orderId: running!.id, status: 'active' },
    ])
    const posting = { userId: customer.id, walletId: wallet.id, balanceBeforeRial: 1000000, balanceAfterRial: 1000000 }
    await ctx.db.insert(walletTransactions).values([
      ...[active!, running!, failed!, refunded!].map(order => ({ ...posting, type: 'purchase' as const, amountRial: -order.totalRial, referenceId: order.id, referenceType: 'order' })),
      { ...posting, type: 'refund', amountRial: 5000, referenceId: refunded!.id, referenceType: 'order' },
      { ...posting, type: 'renewal', amountRial: -1000 },
      { ...posting, type: 'deposit', amountRial: 350000 },
    ])
    await ctx.db.insert(invoices).values([active!, running!, failed!, refunded!].map((order): typeof invoices.$inferInsert => ({
      userId: customer.id, orderId: order.id, invoiceNumber: 'INV-' + order.orderNumber, status: order.status === 'refunded' ? 'void' : 'paid',
      totalRial: order.totalRial, subtotalRial: order.totalRial, taxRial: 0, dueAt: new Date(),
    })))
    const [op] = await ctx.db.insert(providerOperations).values({ provider: 'hetzner', kind: 'provision', action: 'create', referenceType: 'order',
      referenceId: failed!.id, businessKey: 'fixture-overview-failure', status: 'failed' }).returning()
    const headers = { authorization: `Bearer ${adminToken}` }
    const overview = () => app.inject({ url: '/api/admin/console/overview', headers })
    expect((await overview()).json().data.finance).toBeUndefined()
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, adminId))
    try {
      const response = await overview()
      expect(response.statusCode, response.body).toBe(200)
      const { data } = response.json()
      expect(data.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'super_admin', count: 1 }), expect.objectContaining({ role: 'user' })]))
      expect(data.serverCounts).toEqual({ active: 1, terminated: 1 })
      expect(data.recentOrders).toEqual(expect.arrayContaining([expect.objectContaining({ orderNumber: 'OV-A', status: 'active', serverStatus: 'terminated' })]))
      expect(data.finance).toMatchObject({ initialRial: 171000, renewalRial: 1000, refundsRial: 5000, netRial: 211000, depositsRial: 350000,
        exceptionCount: 1, exceptions: [{ id: failed!.id, debitRial: 39000, refundRial: 0, unreturned: true }] })
      const evidence = (await app.inject({ url: `/api/admin/console/orders/${failed!.id}`, headers })).json().data.financialEvidence
      expect(evidence.operations[0].id).toBe(op!.id)
      expect(evidence.transactionIds).toHaveLength(1)
      expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, customer.id) })).toHaveLength(7)
      await ctx.db.update(invoices).set({ totalRial: 162000 }).where(eq(invoices.orderId, active!.id))
      expect((await overview()).json().data.finance).toMatchObject({ initialRial: 171000, exceptionCount: 2,
        exceptions: [expect.objectContaining({ id: failed!.id }), expect.objectContaining({ id: active!.id, invoicedRial: 162000, debitRial: 161000, mismatch: true })] })
    } finally { await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, adminId)) }
  })
})
