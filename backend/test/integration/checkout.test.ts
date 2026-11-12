import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import * as configuration from '../../src/config.js'
import { providers, users } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { minimumCreationBalanceRial } from '../../src/modules/billing/creation-funding.js'
import { enableAllOffersForSale, findOfferByProductAndLocation, syncProviderCatalog } from '../../src/modules/catalog/service.js'
import { createOrderFromQuote, payOrder } from '../../src/modules/orders/service.js'
import { handleProvision } from '../../src/modules/provisioning/handlers.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { getProvider, registerProvider, registerConfiguredProviders } from '../../src/modules/providers/registry.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { creditWallet, ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

describe.skipIf(!dbAvailable)('checkout funding, datacenter sales and Issue #3', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let app: FastifyInstance
  let offer: NonNullable<Awaited<ReturnType<typeof findOfferByProductAndLocation>>>
  let sequence = 0
  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    const original = getProvider('leaseweb')
    registerProvider({ ...original, id: 'hetzner', name: 'Hetzner', async syncCatalog() {
      const catalog = await original.syncCatalog()
      return { ...catalog, offers: catalog.offers.map(o => ({ ...o, provider: 'hetzner', category: 'cloud' as const,
        billingOptions: [{ billingCycle: 'hourly', amountCents: 10 }] })) }
    } })
    await setFxRate(ctx.db, '620000')
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner'))
    await enableAllOffersForSale(ctx.db, 'hetzner')
    offer = (await findOfferByProductAndLocation(ctx.db, 'hetzner', 'VPS02_4', 'FRA-01'))!
    const base = configuration.getConfig()
    vi.spyOn(configuration, 'getConfig').mockReturnValue({ ...base, DATA_AUTHORITY: 'site',
      PROVIDERS: { ...base.PROVIDERS, hetzner: { ...base.PROVIDERS.hetzner, enabled: true, orderingEnabled: true } } })
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })
  afterAll(async () => {
    await app?.close()
    if (ctx) { await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner')); await ctx.close() }
    vi.restoreAllMocks(); registerConfiguredProviders()
  })
  async function account(admin = false) {
    const user = await registerUser(ctx.db, { email: `checkout-${++sequence}@test.local`, password: 'Safe-fixture-pass-123!' })
    if (admin) await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id))
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    const token = (await createSession(ctx.db, user.id, {})).token
    return { user, wallet, headers: { authorization: `Bearer ${token}` } }
  }
  const quoteFor = (userId: string) => createQuote(ctx.db, { userId, offerId: offer.id, locationCode: 'FRA-01', billingOption: { billingCycle: 'hourly' }, billingPeriod: 'hourly', operatingSystem: 'ubuntu-24.04' })
  const body = (walletId: string) => ({ name: 'checkout-server', walletId, offerId: offer.id, os: 'ubuntu-24.04', billingPeriod: 'hourly' })

  it('returns structured shortfall and creates no order, invoice, debit, server or provider operation on insufficient balance', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    const required = minimumCreationBalanceRial(q.totalRial, 'HOURLY')
    await creditWallet(ctx.db, a.user.id, a.wallet.id, required - 1, { type: 'manual_credit' })
    const response = await app.inject({ method: 'POST', url: '/api/servers', headers: { ...a.headers, 'idempotency-key': 'underfunded' }, payload: body(a.wallet.id) })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'insufficient_funds', message: 'موجودی کیف پول شما کافی نیست.', details: { requiredBalanceRial: required, shortfallRial: 1 } })
    expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.invoices.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.servers.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
    expect(await ctx.db.query.providerOperations.findMany()).toHaveLength(0)
    // Same failed command can succeed after funding, without consuming its key.
    await creditWallet(ctx.db, a.user.id, a.wallet.id, 1, { type: 'manual_credit' })
    const success = await app.inject({ method: 'POST', url: '/api/servers', headers: { ...a.headers, 'idempotency-key': 'underfunded' }, payload: body(a.wallet.id) })
    expect(success.statusCode).toBe(201)
    const balance = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, a.wallet.id) }))!.balanceRial
    expect(balance).toBe(required - q.totalRial)
  })

  it('serializes simultaneous retries to one order and debit and scopes replay to its owner', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const input = { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'retry-server', idempotencyKey: 'concurrent-retry' }
    const [first, second] = await Promise.all([createOrderFromQuote(ctx.db, input), createOrderFromQuote(ctx.db, input)])
    expect(first.order.id).toBe(second.order.id)
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.referenceId, first.order.id) })).toHaveLength(1)
    const b = await account()
    await expect(createOrderFromQuote(ctx.db, { ...input, userId: b.user.id, walletId: b.wallet.id })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recovers a failed queue enqueue by replaying the paid order without charging again', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const enqueue = vi.spyOn(ctx.queues, 'addProvision').mockRejectedValueOnce(new Error('fixture queue unavailable'))
    try {
      const request = { method: 'POST' as const, url: '/api/servers', headers: { ...a.headers, 'idempotency-key': 'queue-recovery' }, payload: body(a.wallet.id) }
      expect((await app.inject(request)).statusCode).toBe(500)
      const replay = await app.inject(request)
      expect(replay.statusCode).toBe(200)
      expect(enqueue).toHaveBeenCalledTimes(2)
      expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1])
      expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
      const transactions = await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })
      expect(transactions.filter(t => t.type === 'purchase')).toHaveLength(1)
    } finally { enqueue.mockRestore() }
  })

  it('does not reuse one week of funds for two simultaneous distinct orders', async () => {
    const a = await account()
    const [q1, q2] = await Promise.all([quoteFor(a.user.id), quoteFor(a.user.id)])
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q1.totalRial * 168, { type: 'manual_credit' })
    const results = await Promise.allSettled([q1, q2].map(q => createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'quota-safe' })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'insufficient_funds' } })
  })

  it('applies the funding rule to deferred payments and binds their actual payment wallet', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    const unpaid = await createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, hostname: 'deferred-payment' })
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168 - 1, { type: 'manual_credit' })
    const payment = { userId: a.user.id, walletId: a.wallet.id, orderId: unpaid.order.id }
    await expect(payOrder(ctx.db, payment)).rejects.toMatchObject({ code: 'insufficient_funds' })
    await creditWallet(ctx.db, a.user.id, a.wallet.id, 1, { type: 'manual_credit' })
    const paid = await payOrder(ctx.db, payment)
    expect(paid.walletId).toBe(a.wallet.id)
    const secondQuote = await quoteFor(a.user.id)
    await expect(createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: secondQuote.id, walletId: a.wallet.id, hostname: 'second-deferred' })).rejects.toMatchObject({ code: 'insufficient_funds' })
  })

  it('counts already-active server renewals and never provisions twice on replay', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const first = await createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'existing-active' })
    expect((await handleProvision(ctx, { orderId: first.order.id })).status).toBe('provisioned')
    expect((await handleProvision(ctx, { orderId: first.order.id })).status).toBe('already_provisioned')
    const second = await quoteFor(a.user.id)
    await expect(createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: second.id, walletId: a.wallet.id, hostname: 'beyond-quota' })).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(await ctx.db.query.servers.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
    expect(await ctx.db.query.providerOperations.findMany({ where: t => eq(t.referenceId, first.order.id) })).toHaveLength(1)
  })

  it('keeps sales changes admin-only, audited, sync-stable and enforced on stale quotes while allowing admin purchases', async () => {
    const admin = await account(true)
    const customer = await account()
    const stale = await quoteFor(customer.user.id)
    const awaitingQuote = await quoteFor(customer.user.id)
    const awaiting = await createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: awaitingQuote.id, hostname: 'disabled-later' })
    const request = { method: 'PATCH' as const, url: '/api/admin/console/providers/hetzner', payload: { enabled: false } }
    expect((await app.inject(request)).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: customer.headers })).statusCode).toBe(403)
    expect((await app.inject({ ...request, headers: admin.headers })).statusCode).toBe(200)
    expect((await app.inject({ ...request, headers: admin.headers })).statusCode).toBe(200)
    expect(await ctx.db.query.auditLogs.findMany({ where: t => eq(t.action, 'provider.sales_changed') })).toHaveLength(1)
    expect((await app.inject('/api/catalog/storefront')).json().data.datacenters).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hetzner' })]))
    const adminCatalog = await app.inject({ url: '/api/catalog/storefront', headers: admin.headers })
    expect(adminCatalog.json().data.datacenters).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hetzner' })]))
    expect(adminCatalog.headers['cache-control']).toBe('private, no-store')
    expect(adminCatalog.headers.vary).toContain('Authorization')
    await expect(quoteFor(customer.user.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: stale.id, hostname: 'stale-quote' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(payOrder(ctx.db, { userId: customer.user.id, orderId: awaiting.order.id, walletId: customer.wallet.id })).rejects.toMatchObject({ code: 'forbidden' })
    const q = await quoteFor(admin.user.id)
    await creditWallet(ctx.db, admin.user.id, admin.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    expect((await createOrderFromQuote(ctx.db, { userId: admin.user.id, quoteId: q.id, walletId: admin.wallet.id, hostname: 'admin-checkout' })).created).toBe(true)
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    expect((await ctx.db.query.providers.findFirst({ where: t => eq(t.id, 'hetzner') }))!.enabled).toBe(false)
  })
})
