import { nativePeriod } from '../../src/modules/pricing/periods.js'
import type { ProviderBillingOption } from '../../src/modules/providers/provider.interface.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable, type TestContext } from '../helpers.js'
import { subscriptions, users, fxRates } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { buildApp } from '../../src/app.js'
import { testLogger } from '../helpers.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { getProvider, registerProvider, registerConfiguredProviders } from '../../src/modules/providers/registry.js'
import { setFxRate, updatePricingRules } from '../../src/modules/pricing/service.js'
import { renewalPrice } from '../../src/modules/pricing/renewal.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { handleProvision, handleRenewalSweep } from '../../src/modules/provisioning/handlers.js'

// Provider transport is an isolated fixture; wallet, quote, order and renewal use PostgreSQL.
describe.skipIf(!dbAvailable)('hourly billing and grandfathered daily boundaries', () => {
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
        return { ...catalog, offers: catalog.offers.map((offer) => ({ ...offer, provider: 'hetzner', category: 'cloud' as const, billingOptions: [{ billingCycle: 'hourly', amount: '0.0055' }, ...offer.billingOptions] })) }
      },
    })
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    await enableAllOffersForSale(ctx.db, 'hetzner')
  })
  afterAll(async () => { registerConfiguredProviders(); await ctx.close() })
  afterEach(() => vi.useRealTimers())

  async function buy(period: 'hourly' | 'daily' | 'monthly', email: string) {
    const user = await registerUser(ctx.db, { email, password: 'Retail-boundary-123!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 1000000000, { type: 'manual_credit' })
    const offer = await findOfferByProductAndLocation(ctx.db, 'hetzner', 'VPS02_4', 'FRA-01')
    const quote = await createQuote(ctx.db, {
      userId: user.id, offerId: offer!.id, locationCode: 'FRA-01',
      billingOption: period === 'monthly' ? (offer!.billingOptions as ProviderBillingOption[]).find(o => nativePeriod(o) === 'monthly')! : { billingCycle: 'hourly' }, billingPeriod: period, operatingSystem: 'ubuntu-24.04',
    })
    const result = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: `retail-${period}` })
    await handleProvision(ctx, { orderId: result.order.id })
    const subscription = await ctx.db.query.subscriptions.findFirst({ where: (t) => eq(t.orderId, result.order.id) })
    return { quote, order: result.order, subscription: subscription!, wallet }
  }

  it('blocks a new daily quote while preserving grandfathered daily records', async () => {
    await expect(buy('daily', 'daily-blocked@test.local')).rejects.toMatchObject({ code: 'validation_error' })
    const purchase = await buy('hourly', 'legacy-daily@test.local')
    const end = new Date(purchase.subscription.currentPeriodStart.getTime() + 86400000)
    await ctx.db.update(subscriptions).set({ billingInterval: 'DAILY', currentPeriodEnd: end, nextInvoiceAt: end, nextDueAt: end }).where(eq(subscriptions.id, purchase.subscription.id))
    await handleRenewalSweep(ctx)
    const preserved = await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, purchase.subscription.id) })
    expect(preserved!.billingInterval).toBe('DAILY')
    expect(preserved!.currentPeriodEnd).toEqual(end)
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
      await setFxRate(ctx.db, '620000')
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
  it('prices each new hour using fresh FX, with an exact immutable invoice and one debit on retries', async () => {
    await setFxRate(ctx.db, '620000')
    const purchase = await buy('hourly', 'changing-hour@test.local')
    const before = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial
    const due = new Date(Date.now() - 1000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, purchase.subscription.id))
    await setFxRate(ctx.db, '1240000')
    await Promise.all([handleRenewalSweep(ctx), handleRenewalSweep(ctx)])
    const invoice = (await ctx.db.query.invoices.findMany({ where: t => eq(t.subscriptionId, purchase.subscription.id) }))[0]!
    expect(invoice.totalRial).toBe(8525)
    expect(before - (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(8525)
    expect(invoice.snapshot).toMatchObject({ fxRate: '1240000.000000', totalRial: 8525, ledgerPrecisionRial: 1 })
    await setFxRate(ctx.db, '2480000')
    await handleRenewalSweep(ctx)
    expect((await ctx.db.query.invoices.findFirst({ where: t => eq(t.id, invoice.id) }))!.snapshot).toEqual(invoice.snapshot)
    const debits = (await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.walletId, purchase.wallet.id) })).filter(t => t.type === 'renewal')
    expect(debits).toHaveLength(1); expect(debits[0]!.amountRial).toBe(-invoice.totalRial)
  })
  it('keeps a prepaid monthly invoice and dates unchanged after FX rises; only the next paid month reprices', async () => {
    await setFxRate(ctx.db, '620000')
    const purchase = await buy('monthly', 'fixed-month@test.local')
    const before = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial
    const original = await ctx.db.query.invoices.findFirst({ where: t => eq(t.orderId, purchase.order.id) })
    await setFxRate(ctx.db, '1860000')
    await handleRenewalSweep(ctx)
    expect((await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, purchase.subscription.id) }))!.priceRial).toBe(purchase.order.totalRial)
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(purchase.subscription.currentPeriodEnd.getTime() + 1000)
    await setFxRate(ctx.db, '1860000')
    await handleRenewalSweep(ctx)
    const next = (await ctx.db.query.invoices.findMany({ where: t => eq(t.subscriptionId, purchase.subscription.id) }))[0]!
    expect(next.totalRial).toBe(purchase.order.totalRial * 3)
    expect(next.status).toBe('paid')
    expect((await ctx.db.query.invoices.findFirst({ where: t => eq(t.id, original!.id) }))!.snapshot).toEqual(original!.snapshot)
  })
  it('refuses an hour with unavailable FX without creating an invoice or changing the wallet', async () => {
    await setFxRate(ctx.db, '620000')
    const purchase = await buy('hourly', 'missing-hour-fx@test.local')
    const before = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial
    const due = new Date(Date.now() - 1000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, purchase.subscription.id))
    await ctx.db.delete(fxRates)
    await expect(handleRenewalSweep(ctx)).rejects.toMatchObject({ code: 'renewal_fx_unavailable' })
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before)
    expect(await ctx.db.query.invoices.findMany({ where: t => eq(t.subscriptionId, purchase.subscription.id) })).toHaveLength(0)
  })

  it('uses the margin in force for a missed hour and the newer margin for the next renewal', async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(hour + 60_000)
    await setFxRate(ctx.db, '620000')
    const original = await updatePricingRules(ctx.db, 'hetzner', { markupPercent: 0, markupFixedRial: 0 })
    const purchase = await buy('hourly', 'hourly-historical-margin@test.local')
    vi.setSystemTime(hour + 3_600_000 + 60_000)
    const changed = await updatePricingRules(ctx.db, 'hetzner', { markupPercent: 25, markupFixedRial: 0 })
    const missed = await renewalPrice(ctx.db, purchase.order.id, 'HOURLY', new Date(hour + 120_000))
    const next = await renewalPrice(ctx.db, purchase.order.id, 'HOURLY', new Date())
    expect(missed).toMatchObject({ totalRial: purchase.quote.totalRial, ruleVersion: original.updatedAt.toISOString() })
    expect(next.totalRial).toBeGreaterThan(missed.totalRial)
    expect(next.ruleVersion).toBe(changed.updatedAt.toISOString())
  })
})
