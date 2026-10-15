import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable } from '../helpers.js'
import { registerUser } from '../../src/modules/auth/service.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote, payOrder } from '../../src/modules/orders/service.js'
import { getProvider } from '../../src/modules/providers/registry.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { handleProvision } from '../../src/modules/provisioning/handlers.js'
import { ValidationError, ConflictError } from '../../src/lib/errors.js'

const skip = !dbAvailable

describe.skipIf(skip)('orders + vertical slice (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    await setFxRate(ctx.db, '620000', { note: 'test fixture' })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
  })

  afterAll(async () => {
    await ctx.close()
  })

  async function fundedUser(email: string) {
    const user = await registerUser(ctx.db, { email, password: 'Pass123456!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 100_000_000, { type: 'manual_credit', description: 'تست' })
    return { user, wallet }
  }

  async function makeMonthlyQuote(userId: string) {
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    expect(offer).toBeTruthy()
    return createQuote(ctx.db, {
      userId,
      offerId: offer!.id,
      locationCode: 'FRA-01',
      billingOption: { billingCycle: 'monthly', contractTerm: 0 },
      operatingSystem: 'ubuntu-24.04',
    })
  }

  it('runs the full slice: catalog -> quote -> order -> provision -> active server', async () => {
    const { user, wallet } = await fundedUser('slice@test.local')
    const quote = await makeMonthlyQuote(user.id)
    expect(quote.totalRial).toBeGreaterThan(0)
    // Snapshot math: 1450 cents * 620000/100 = 8,990,000; +25% = 11,237,500; rounded 11,238,000
    expect(quote.totalRial).toBe(11_238_000)

    const before = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial

    const { order, created } = await createOrderFromQuote(ctx.db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname: 'slice-vps',
      idempotencyKey: 'slice-order-1',
    })
    expect(created).toBe(true)
    expect(order.status).toBe('paid')

    // Wallet debited exactly the snapshot total.
    const after = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial
    expect(before - after).toBe(quote.totalRial)

    // Invoice created and paid.
    const invoice = await ctx.db.query.invoices.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(invoice).toBeTruthy()
    expect(invoice!.status).toBe('paid')

    // Provision (worker handler) — mock provider creates the VPS.
    const result = await handleProvision(ctx, { orderId: order.id })
    expect(result.status).toBe('provisioned')

    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(server).toBeTruthy()
    expect(server!.status).toBe('active')
    expect(server!.providerServerId).toBeTruthy()
    expect(server!.ipv4).toBeTruthy()

    const sub = await ctx.db.query.subscriptions.findFirst({ where: (t) => eq(t.serverId, server!.id) })
    expect(sub).toBeTruthy()
    expect(sub!.billingInterval).toBe('MONTHLY')

    // Replay is a no-op (idempotent).
    const replay = await handleProvision(ctx, { orderId: order.id })
    expect(replay.status).toBe('already_provisioned')
    const opCount = await ctx.db.query.providerOperations.findMany({ where: (t) => eq(t.referenceId, order.id) })
    expect(opCount.length).toBe(1)
  })

  it('rejects a duplicate POST with the same idempotency key without double-charging', async () => {
    const { user, wallet } = await fundedUser('idem@test.local')
    const quote = await makeMonthlyQuote(user.id)
    const first = await createOrderFromQuote(ctx.db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname: 'idem-vps',
      idempotencyKey: 'idem-key-1',
    })
    const second = await createOrderFromQuote(ctx.db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname: 'idem-vps',
      idempotencyKey: 'idem-key-1',
    })
    expect(second.created).toBe(false)
    expect(second.order.id).toBe(first.order.id)
    const tx = await ctx.db.query.walletTransactions.findMany({
      where: (t) => eq(t.referenceId, first.order.id),
    })
    expect(tx.length).toBe(1)
  })

  it('rejects an expired quote', async () => {
    const { user } = await fundedUser('expired@test.local')
    const quote = await makeMonthlyQuote(user.id)
    await ctx.db.execute(sql`update quotes set expires_at = now() - interval '1 minute' where id = ${quote.id}`)
    await expect(
      createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, hostname: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('a quote can only be consumed once', async () => {
    const { user, wallet } = await fundedUser('once@test.local')
    const quote = await makeMonthlyQuote(user.id)
    await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: 'once-vps' })
    await expect(
      createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: 'once-vps-2' }),
    ).rejects.toBeInstanceOf(ValidationError) // status no longer valid
  })

  it('pays an awaiting_payment order later', async () => {
    const { user, wallet } = await fundedUser('paylater@test.local')
    const quote = await makeMonthlyQuote(user.id)
    const { order } = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, hostname: 'pay-vps' })
    expect(order.status).toBe('awaiting_payment')
    const paid = await payOrder(ctx.db, { userId: user.id, orderId: order.id, walletId: wallet.id })
    expect(paid!.status).toBe('paid')
    // Paying twice is idempotent.
    const again = await payOrder(ctx.db, { userId: user.id, orderId: order.id, walletId: wallet.id })
    expect(again!.status).toBe('paid')
  })

  it('cancels unpaid orders and guards the state machine', async () => {
    const { user } = await fundedUser('trans@test.local')
    const quote = await makeMonthlyQuote(user.id)
    const { order } = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, hostname: 'trans-vps' })
    const { cancelUnpaidOrder } = await import('../../src/modules/orders/service.js')
    await cancelUnpaidOrder(ctx.db, { userId: user.id, orderId: order.id })
    const cancelled = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, order.id) })
    expect(cancelled!.status).toBe('cancelled')
    // Cancelling again must fail (state machine).
    await expect(cancelUnpaidOrder(ctx.db, { userId: user.id, orderId: order.id })).rejects.toBeInstanceOf(ConflictError)
  })
})