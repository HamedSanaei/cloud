import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { dbAvailable, getTestContext, truncateAll, testLogger } from '../helpers.js'
import type { TestContext } from '../helpers.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { getProvider, registerProvider } from '../../src/modules/providers/registry.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { registerUser, createSession } from '../../src/modules/auth/service.js'
import { ensureDefaultWallet, createWallet, creditWallet, debitWallet } from '../../src/modules/wallets/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'
import { handleProvision, handleRenewalSweep, handleServerAction, handleServerSync } from '../../src/modules/provisioning/handlers.js'
import { createServerActionOperation } from '../../src/modules/servers/service.js'
import { subscriptions } from '../../src/db/schema.js'
import { buildApp } from '../../src/app.js'
import { loadFundingFleet, warnLowBalance } from '../../src/modules/billing/funding.js'
import { retailBilling } from '../../src/modules/pricing/periods.js'
import type { RetailPeriod } from '../../src/modules/pricing/periods.js'
import type { ProviderBillingOption } from '../../src/modules/providers/provider.interface.js'
import type { FastifyInstance } from 'fastify'
import type { serverToDto } from '../../src/lib/dto.js'

describe.skipIf(!dbAvailable)('hourly funding safety', () => {
  let ctx: TestContext
  let app: FastifyInstance
  let serverNumber = 0
  beforeAll(async () => {
    ctx = await getTestContext()
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })
  afterAll(async () => { await app.close(); await ctx.close() })
  beforeEach(async () => {
    await truncateAll(ctx.db)
    serverNumber = 0
    ctx.mockProvider.reset()
    const mock = ctx.mockProvider
    registerProvider({
      ...mock,
      async syncCatalog() {
        const catalog = await mock.syncCatalog()
        return { ...catalog, offers: catalog.offers.map((offer) => ({ ...offer, category: 'cloud' as const, billingOptions: [{ billingCycle: 'hourly', amount: '0.10' }, ...offer.billingOptions] })) }
      },
    })
    await setFxRate(ctx.db, '620000')
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
  })

  async function purchasedServer(existingUserId?: string, period: RetailPeriod = 'hourly') {
    const user = existingUserId ? { id: existingUserId } : await registerUser(ctx.db, { email: 'funding@test.local', password: 'Funding-boundary-123!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    if (!existingUserId) await creditWallet(ctx.db, user.id, wallet.id, 100000000, { type: 'manual_credit' })
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    const native = retailBilling(offer!.billingOptions as ProviderBillingOption[], period).native
    const quote = await createQuote(ctx.db, { userId: user.id, offerId: offer!.id, locationCode: 'FRA-01', billingOption: native, billingPeriod: period, operatingSystem: 'ubuntu-24.04' })
    const { order } = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: `funding-server-${++serverNumber}` })
    await handleProvision(ctx, { orderId: order.id })
    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    const session = await createSession(ctx.db, user.id, {})
    return { user, wallet, server: server!, hourlyPriceRial: quote.totalRial, headers: { authorization: `Bearer ${session.token}` } }
  }

  async function setBalance(purchase: Awaited<ReturnType<typeof purchasedServer>>, amount: number) {
    const wallet = await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) })
    const delta = wallet!.balanceRial - amount
    if (delta > 0) await debitWallet(ctx.db, purchase.user.id, purchase.wallet.id, delta, { type: 'manual_debit' })
    if (delta < 0) await creditWallet(ctx.db, purchase.user.id, purchase.wallet.id, -delta, { type: 'manual_credit' })
  }

  async function panel(purchase: Awaited<ReturnType<typeof purchasedServer>>) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/servers/${purchase.server.id}`, headers: purchase.headers })
    expect(response.statusCode).toBe(200)
    return response.json<{ data: ReturnType<typeof serverToDto> }>().data
  }

  it('requests a real provider shutdown at zero balance without waiting for grace expiry', async () => {
    const purchase = await purchasedServer()
    const wallet = await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) })
    await debitWallet(ctx.db, purchase.user.id, purchase.wallet.id, wallet!.balanceRial, { type: 'manual_debit' })
    await handleRenewalSweep(ctx)
    const shutdown = await ctx.db.query.providerOperations.findFirst({ where: (t) => and(eq(t.referenceId, purchase.server.id), eq(t.action, 'power_off')) })
    expect(shutdown?.status).toBe('pending')
    await handleServerAction(ctx, { operationId: shutdown!.id, serverId: purchase.server.id, action: 'power_off' })
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('suspended')
  })

  it('executes a newly queued power action instead of ignoring pending operations', async () => {
    const purchase = await purchasedServer()
    const operation = await createServerActionOperation(ctx.db, purchase.server.id, 'power_off')
    await Promise.all([handleServerAction(ctx, { operationId: operation.id, serverId: purchase.server.id, action: 'power_off' }), handleServerAction(ctx, { operationId: operation.id, serverId: purchase.server.id, action: 'power_off' })])
    expect((await ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.id, operation.id) }))!.attemptCount).toBe(1)
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('suspended')
  })

  it.each([{ below: true }, { below: false }])('protects the positive one-hour boundary: $below', async ({ below }) => {
    const purchase = await purchasedServer()
    await setBalance(purchase, purchase.hourlyPriceRial - (below ? 1 : 0))
    await handleRenewalSweep(ctx)
    const operation = await ctx.db.query.providerOperations.findFirst({ where: (t) => and(eq(t.referenceId, purchase.server.id), eq(t.action, 'power_off')) })
    expect(!!operation).toBe(below)
    if (operation) await handleServerAction(ctx, { operationId: operation.id, serverId: purchase.server.id, action: 'power_off' })
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe(below ? 'suspended' : 'active')
  })

  it('shares one-hour funding across all active servers without double-counting a wallet', async () => {
    const first = await purchasedServer()
    const second = await purchasedServer(first.user.id)
    await setBalance(first, first.hourlyPriceRial)
    await Promise.all([handleRenewalSweep(ctx), handleRenewalSweep(ctx)])
    const operations = await ctx.db.query.providerOperations.findMany({ where: (t) => and(eq(t.kind, 'server_action'), eq(t.action, 'power_off')) })
    expect(operations).toHaveLength(2)
    for (const operation of operations) await handleServerAction(ctx, { operationId: operation.id, serverId: operation.referenceId, action: 'power_off' })
    for (const purchase of [first, second]) expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('suspended')
  })

  it('blocks unfunded starts in the API, restores them after funding the correct wallet, and supports another shutdown cycle', async () => {
    const purchase = await purchasedServer()
    await setBalance(purchase, 0)
    await handleRenewalSweep(ctx)
    const firstStop = (await ctx.db.query.providerOperations.findFirst({ where: (t) => and(eq(t.referenceId, purchase.server.id), eq(t.action, 'power_off')) }))!
    await handleServerAction(ctx, { operationId: firstStop.id, serverId: purchase.server.id, action: 'power_off' })
    expect((await panel(purchase)).power.canPowerOn).toBe(false)
    const startUrl = `/api/v1/servers/${purchase.server.id}/actions/power-on`
    expect((await app.inject({ method: 'POST', url: startUrl, headers: purchase.headers, payload: {} })).statusCode).toBe(422)
    const spare = await createWallet(ctx.db, purchase.user.id, { name: 'unrelated funds' })
    await creditWallet(ctx.db, purchase.user.id, spare.id, purchase.hourlyPriceRial * 100, { type: 'manual_credit' })
    expect((await panel(purchase)).power.canPowerOn).toBe(false)
    await creditWallet(ctx.db, purchase.user.id, purchase.wallet.id, purchase.hourlyPriceRial, { type: 'manual_credit' })
    expect((await panel(purchase)).power.canPowerOn).toBe(true)
    const response = await app.inject({ method: 'POST', url: startUrl, headers: purchase.headers, payload: {} })
    expect(response.statusCode).toBe(200)
    await handleServerAction(ctx, { operationId: response.json<{ data: { operationId: string } }>().data.operationId, serverId: purchase.server.id, action: 'power_on' })
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('active')
    await setBalance(purchase, 0)
    await handleRenewalSweep(ctx)
    const stops = await ctx.db.query.providerOperations.findMany({ where: (t) => and(eq(t.referenceId, purchase.server.id), eq(t.action, 'power_off')), orderBy: (t, { desc }) => [desc(t.createdAt)] })
    expect(stops).toHaveLength(2)
    expect(stops[0]!.id).not.toBe(firstStop.id)
    await handleServerAction(ctx, { operationId: stops[0]!.id, serverId: purchase.server.id, action: 'power_off' })
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('suspended')
  })

  it('rejects a queued start if funds disappear and never auto-starts that old request after a top-up', async () => {
    const purchase = await purchasedServer()
    const stop = await createServerActionOperation(ctx.db, purchase.server.id, 'power_off')
    await handleServerAction(ctx, { operationId: stop.id, serverId: purchase.server.id, action: 'power_off' })
    const start = await createServerActionOperation(ctx.db, purchase.server.id, 'power_on')
    await setBalance(purchase, 0)
    expect((await handleServerAction(ctx, { operationId: start.id, serverId: purchase.server.id, action: 'power_on' })).status).toBe('insufficient_funds')
    await creditWallet(ctx.db, purchase.user.id, purchase.wallet.id, purchase.hourlyPriceRial, { type: 'manual_credit' })
    await handleServerAction(ctx, { operationId: start.id, serverId: purchase.server.id, action: 'power_on' })
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('suspended')
  })

  it('pauses hourly charging while off and resumes renewal only after a funded start', async () => {
    const purchase = await purchasedServer()
    const stop = await createServerActionOperation(ctx.db, purchase.server.id, 'power_off')
    await handleServerAction(ctx, { operationId: stop.id, serverId: purchase.server.id, action: 'power_off' })
    const due = new Date(Date.now() - 60000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, purchase.server.subscriptionId!))
    const before = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial
    expect((await handleRenewalSweep(ctx)).renewed).toBe(0)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before)
    const start = await createServerActionOperation(ctx.db, purchase.server.id, 'power_on')
    await handleServerAction(ctx, { operationId: start.id, serverId: purchase.server.id, action: 'power_on' })
    expect((await handleRenewalSweep(ctx)).renewed).toBe(1)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(before - purchase.hourlyPriceRial)
  })

  it('persists a six-hour per-user warning cooldown and excludes an exact 72-hour horizon', async () => {
    const purchase = await purchasedServer()
    const now = new Date()
    const next = new Date(now.getTime() + 3600000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: next, nextInvoiceAt: next, nextDueAt: next }).where(eq(subscriptions.id, purchase.server.subscriptionId!))
    await setBalance(purchase, purchase.hourlyPriceRial * 72)
    expect(await ctx.db.transaction(async (tx) => warnLowBalance(tx, purchase.user.id, await loadFundingFleet(tx, purchase.user.id), now))).toBe(false)
    await setBalance(purchase, purchase.hourlyPriceRial * 72 - 1)
    const fleet = await loadFundingFleet(ctx.db, purchase.user.id)
    const first = await Promise.all([0, 1, 2].map(() => ctx.db.transaction((tx) => warnLowBalance(tx, purchase.user.id, fleet, now))))
    expect(first.filter(Boolean)).toHaveLength(1)
    expect(await ctx.db.transaction((tx) => warnLowBalance(tx, purchase.user.id, fleet, new Date(now.getTime() + 6 * 3600000 - 1)))).toBe(false)
    expect(await ctx.db.transaction((tx) => warnLowBalance(tx, purchase.user.id, fleet, new Date(now.getTime() + 6 * 3600000)))).toBe(true)
    expect(await ctx.db.query.notifications.findMany({ where: (t) => and(eq(t.userId, purchase.user.id), eq(t.type, 'warning')) })).toHaveLength(2)
  })

  it('warns for an unfunded daily renewal without cutting off the prepaid day', async () => {
    const purchase = await purchasedServer(undefined, 'daily')
    await setBalance(purchase, 0)
    await handleRenewalSweep(ctx)
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('active')
    expect(await ctx.db.query.notifications.findMany({ where: (t) => and(eq(t.userId, purchase.user.id), eq(t.type, 'warning')) })).toHaveLength(1)
  })

  it('respects prepaid monthly time and warns when an unfunded renewal enters the next three days', async () => {
    const purchase = await purchasedServer(undefined, 'monthly')
    await setBalance(purchase, 0)
    await handleRenewalSweep(ctx)
    expect(await ctx.db.query.notifications.findMany({ where: (t) => eq(t.type, 'warning') })).toHaveLength(0)
    const next = new Date(Date.now() + 2 * 86400000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: next, nextInvoiceAt: next, nextDueAt: next }).where(eq(subscriptions.id, purchase.server.subscriptionId!))
    await handleRenewalSweep(ctx)
    expect((await ctx.mockProvider.getServer(purchase.server.providerServerId!)).state).toBe('active')
    expect(await ctx.db.query.notifications.findMany({ where: (t) => eq(t.type, 'warning') })).toHaveLength(1)
  })

  it('resumes charging when a funded VM is observed running after an interrupted power worker', async () => {
    const purchase = await purchasedServer()
    await setBalance(purchase, 0)
    await handleRenewalSweep(ctx)
    const stop = (await ctx.db.query.providerOperations.findFirst({ where: (t) => and(eq(t.referenceId, purchase.server.id), eq(t.action, 'power_off')) }))!
    await handleServerAction(ctx, { operationId: stop.id, serverId: purchase.server.id, action: 'power_off' })
    await creditWallet(ctx.db, purchase.user.id, purchase.wallet.id, purchase.hourlyPriceRial * 4, { type: 'manual_credit' })
    // Provider accepted the start, but the worker died before persisting the cleared billing block.
    await ctx.mockProvider.powerOn(purchase.server.providerServerId!)
    await handleServerSync(ctx, { serverId: purchase.server.id })
    const due = new Date(Date.now() - 60000)
    await ctx.db.update(subscriptions).set({ currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, purchase.server.subscriptionId!))
    expect((await handleRenewalSweep(ctx)).renewed).toBe(1)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, purchase.wallet.id) }))!.balanceRial).toBe(purchase.hourlyPriceRial * 3)
  })
})
