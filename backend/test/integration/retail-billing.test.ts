import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable, type TestContext } from '../helpers.js'
import { subscriptions, users } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { buildApp } from '../../src/app.js'
import { testLogger } from '../helpers.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { getProvider, registerProvider, registerConfiguredProviders } from '../../src/modules/providers/registry.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { handleProvision, handleRenewalSweep } from '../../src/modules/provisioning/handlers.js'

// Provider transport is an isolated fixture; wallet, quote, order and renewal use PostgreSQL.
describe.skipIf(!dbAvailable)('hourly and daily purchase boundaries', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    await setFxRate(ctx.db, '620000')
    const original = getProvider('leaseweb')
    registerProvider({
      ...original,
      id: 'hetzner',
      async syncCatalog() {
        const catalog = await original.syncCatalog()
        return { ...catalog, offers: catalog.offers.map((offer) => ({ ...offer, provider: 'hetzner', category: 'cloud' as const, billingOptions: [{ billingCycle: 'hourly', amount: '0.0055' }] })) }
      },
    })
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    await enableAllOffersForSale(ctx.db, 'hetzner')
  })
  afterAll(async () => { registerConfiguredProviders(); await ctx.close() })
  afterEach(() => vi.useRealTimers())

  async function buy(period: 'hourly' | 'daily', email: string) {
    const user = await registerUser(ctx.db, { email, password: 'Retail-boundary-123!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 1000000, { type: 'manual_credit' })
    const offer = await findOfferByProductAndLocation(ctx.db, 'hetzner', 'VPS02_4', 'FRA-01')
    const quote = await createQuote(ctx.db, {
      userId: user.id, offerId: offer!.id, locationCode: 'FRA-01',
      billingOption: { billingCycle: 'hourly' }, billingPeriod: period, operatingSystem: 'ubuntu-24.04',
    })
    const result = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: `retail-${period}` })
    await handleProvision(ctx, { orderId: result.order.id })
    const subscription = await ctx.db.query.subscriptions.findFirst({ where: (t) => eq(t.orderId, result.order.id) })
    return { quote, order: result.order, subscription: subscription!, wallet }
  }

  it('preserves daily billing and native hourly contract through quote, order and subscription', async () => {
    const purchase = await buy('daily', 'daily-boundary@test.local')
    expect(purchase.quote.providerAmountCents).toBe(13.2)
    expect(purchase.order.billingOption).toMatchObject({ billingCycle: 'hourly', amount: '0.0055' })
    expect(purchase.order.billingInterval).toBe('DAILY')
    expect(purchase.subscription.billingInterval).toBe('DAILY')
    expect(purchase.subscription.currentPeriodEnd.getTime() - purchase.subscription.currentPeriodStart.getTime()).toBe(86400000)
    expect((await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, purchase.order.id) }))?.status).toBe('active')
  })

  it('never debits early and charges only once when concurrent sweeps cross an hourly boundary', async () => {
    const purchase = await buy('hourly', 'hourly-boundary@test.local')
    expect(purchase.subscription.currentPeriodEnd.getTime() - purchase.subscription.currentPeriodStart.getTime()).toBe(3600000)
    const before = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial
    await handleRenewalSweep(ctx)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before)
    const due = new Date(Date.now() - 1000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, purchase.subscription.id))
    await Promise.all([handleRenewalSweep(ctx), handleRenewalSweep(ctx)])
    const after = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial
    expect(before - after).toBe(purchase.order.totalRial)
    const invoices = await ctx.db.query.invoices.findMany({ where: (t) => eq(t.subscriptionId, purchase.subscription.id) })
    expect(invoices.map((invoice) => invoice.status)).toEqual(['paid'])
    const renewed = await ctx.db.query.subscriptions.findFirst({ where: (t) => eq(t.id, purchase.subscription.id) })
    expect(renewed!.currentPeriodEnd.getTime() - renewed!.currentPeriodStart.getTime()).toBe(3600000)
  })
  it('keeps hourly due times anchored across delayed postings, debits each period once and exposes historical schedule context', async () => {
    const purchase = await buy('hourly', 'hourly-no-drift@test.local')
    const firstDue = purchase.subscription.currentPeriodEnd.getTime()
    const before = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let period = 0; period < 3; period++) {
      vi.setSystemTime(firstDue + period * 3600000 + (period + 1) * 60000)
      await Promise.all([handleRenewalSweep(ctx), handleRenewalSweep(ctx)])
      const sub = (await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, purchase.subscription.id) }))!
      expect(sub.currentPeriodStart.getTime()).toBe(firstDue + period * 3600000)
      expect(sub.nextInvoiceAt.getTime()).toBe(firstDue + (period + 1) * 3600000)
    }
    const debits = (await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.walletId, purchase.wallet.id) })).filter(t => t.type === 'renewal')
    expect(debits).toHaveLength(3); expect(new Set(debits.map(t => t.idempotencyKey)).size).toBe(3)
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before - 3 * purchase.order.totalRial)
    await ctx.db.update(users).set({ timezone: 'Asia/Dubai' }).where(eq(users.id, purchase.order.userId))
    const session = await createSession(ctx.db, purchase.order.userId, {}), headers = { authorization: `Bearer ${session.token}` }
    const app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    try {
      expect((await app.inject({ url: '/api/auth/me', headers })).json().data.timezone).toBe('Asia/Dubai')
      const rows = (await app.inject({ url: '/api/wallets/transactions', headers })).json().data.filter((t: { type: string }) => t.type === 'renewal')
      expect(rows.map((t: { scheduledAt: string }) => t.scheduledAt).sort()).toEqual([0, 1, 2].map(p => new Date(firstDue + p * 3600000).toISOString()))
      const renewalIds = new Set(debits.map(t => t.idempotencyKey!.slice(8)))
      const invoiceRows = (await app.inject({ url: '/api/invoices', headers })).json().data.filter((i: { id: string }) => renewalIds.has(i.id))
      expect(invoiceRows).toHaveLength(3); expect(invoiceRows.every((i: { paidAt: string }) => i.paidAt)).toBe(true)
      const postingTimes = invoiceRows.map((i: { paidAt: string }) => Date.parse(i.paidAt)).sort((a: number, b: number) => a - b)
      expect(postingTimes[1] - postingTimes[0]).toBe(61 * 60000)
      expect(postingTimes[2] - postingTimes[1]).toBe(61 * 60000)
    } finally { await app.close() }
  })
})
