import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable } from '../helpers.js'
import { registerUser } from '../../src/modules/auth/service.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { handleProvision, handleReconcile, resolveOperationByAdmin } from '../../src/modules/provisioning/handlers.js'
import { getServerForUser, listServersForUser } from '../../src/modules/servers/service.js'
import { getProvider } from '../../src/modules/providers/registry.js'
import { NotFoundError } from '../../src/lib/errors.js'
import type { MockLeasewebProvider } from '../../src/modules/providers/leaseweb/mock.js'
import { HetznerApiError } from '../../src/modules/providers/hetzner/client.js'
import { provisioningRow } from '../../src/modules/servers/provisioning.js'
import * as rejection from '../../src/modules/provisioning/rejection.js'
import { walletTransactions, servers } from '../../src/db/schema.js'

const skip = !dbAvailable

describe.skipIf(skip)('provisioning safety + permissions (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let mock: MockLeasewebProvider

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    await setFxRate(ctx.db, '620000', { note: 'test fixture' })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
    mock = getProvider('leaseweb') as unknown as MockLeasewebProvider
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Isolate each scenario: fresh provider state, no leaked VPS instances.
    mock.reset()
  })

  afterAll(async () => {
    mock.reset()
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

  async function buyVps(email: string, hostname: string, idemKey: string) {
    const { user, wallet } = await fundedUser(email)
    const quote = await makeMonthlyQuote(user.id)
    const { order } = await createOrderFromQuote(ctx.db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname,
      idempotencyKey: idemKey,
    })
    expect(order.status).toBe('paid')
    return { user, order }
  }

  const ledgerFor = (orderId: string) => ctx.db.query.walletTransactions.findMany({ where: t => and(eq(t.referenceType, 'order'), eq(t.referenceId, orderId)) })

  it('refunds the exact captured debit once after a proven capacity rejection and exposes safe Persian guidance', async () => {
    const { user, order } = await buyVps('capacity67@test.local', 'capacity-67', 'capacity-67')
    const originalDebit = (await ledgerFor(order.id))[0]!
    const create = vi.spyOn(mock, 'createServer').mockRejectedValue(new HetznerApiError(412, 'resource_unavailable', true))
    expect((await handleProvision(ctx, { orderId: order.id })).status).toBe('permanent_failure')
    await Promise.all([handleProvision(ctx, { orderId: order.id }), handleProvision(ctx, { orderId: order.id })])
    expect(create).toHaveBeenCalledOnce()
    const ledger = await ledgerFor(order.id)
    expect(ledger).toHaveLength(2)
    expect(ledger.find(row => row.type === 'purchase')).toEqual(originalDebit)
    expect(ledger.find(row => row.type === 'refund')?.amountRial).toBe(-originalDebit.amountRial)
    expect(ledger.reduce((sum, row) => sum + row.amountRial, 0)).toBe(0)
    expect((await ctx.db.query.orders.findFirst({ where: t => eq(t.id, order.id) }))?.status).toBe('refunded')
    expect((await ctx.db.query.invoices.findFirst({ where: t => eq(t.orderId, order.id) }))?.status).toBe('void')
    expect(await ctx.db.query.servers.findFirst({ where: t => eq(t.orderId, order.id) })).toBeUndefined()
    expect(await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.orderId, order.id) })).toBeUndefined()
    const row = await provisioningRow(ctx.db, user.id, order.id)
    expect(row.tracking.failure).toMatchObject({ code: 'capacity_unavailable', billing: 'refunded', reference: order.orderNumber, canChooseAlternative: true })
    expect(row.tracking.failure?.message).toContain('دیتاسنتر')
    const op = await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.referenceId, order.id) })
    expect(op?.responseMetadata).toMatchObject({ httpStatus: 412, providerCode: 'resource_unavailable', definitiveRejection: true })
    await expect(provisioningRow(ctx.db, crypto.randomUUID(), order.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('completes interrupted rejection settlement on concurrent job replay without a second provider request or credit', async () => {
    const { order } = await buyVps('settle67@test.local', 'settle-67', 'settle-67')
    vi.spyOn(rejection, 'settleRejectedProvision').mockResolvedValueOnce(false)
    const create = vi.spyOn(mock, 'createServer').mockRejectedValue(new HetznerApiError(412, 'resource_unavailable', true))
    await handleProvision(ctx, { orderId: order.id })
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(0)
    await Promise.all(Array.from({ length: 3 }, () => handleProvision(ctx, { orderId: order.id })))
    expect(create).toHaveBeenCalledOnce()
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(1)
  })

  it('keeps legacy failures captured for review and never backfills a refund without persisted proof', async () => {
    const { user, order } = await buyVps('legacy67@test.local', 'legacy-67', 'legacy-67')
    mock.setBehavior({ failNextOrders: 'permanent', failNextOrdersCount: 1 })
    await handleProvision(ctx, { orderId: order.id })
    await handleProvision(ctx, { orderId: order.id })
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(0)
    expect((await provisioningRow(ctx.db, user.id, order.id)).tracking.failure).toMatchObject({ billing: 'captured', canChooseAlternative: false })
  })

  it('does not refund when a resource already exists for the order', async () => {
    const { order } = await buyVps('existing67@test.local', 'existing-67', 'existing-67')
    vi.spyOn(rejection, 'settleRejectedProvision').mockResolvedValueOnce(false)
    vi.spyOn(mock, 'createServer').mockRejectedValue(new HetznerApiError(412, 'resource_unavailable', true))
    await handleProvision(ctx, { orderId: order.id })
    await ctx.db.insert(servers).values({ userId: order.userId, orderId: order.id, provider: order.provider, providerProductId: order.providerProductId,
      providerLocation: order.providerLocation, providerServerId: 'fixture-existing-67', hostname: order.hostname, operatingSystem: order.operatingSystem,
      status: 'active', vcpu: 1, memoryMb: 1024, diskGb: 20 })
    const op = await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.referenceId, order.id) })
    expect(await rejection.settleRejectedProvision(ctx.db, op!.id)).toBe(false)
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(0)
  })

  it('never adds another credit when an operator already refunded the order', async () => {
    const { order } = await buyVps('manual67@test.local', 'manual-67', 'manual-67')
    vi.spyOn(rejection, 'settleRejectedProvision').mockResolvedValueOnce(false)
    vi.spyOn(mock, 'createServer').mockRejectedValue(new HetznerApiError(412, 'resource_unavailable', true))
    await handleProvision(ctx, { orderId: order.id })
    await creditWallet(ctx.db, order.userId, order.walletId!, order.totalRial, { type: 'refund', referenceType: 'order', referenceId: order.id, idempotencyKey: `fixture-manual:${order.id}` })
    await handleProvision(ctx, { orderId: order.id })
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(1)
  })

  it('does not guess a refund when captured debits do not match a single purchase', async () => {
    const { order } = await buyVps('ledger67@test.local', 'ledger-67', 'ledger-67')
    const { applyWalletTransaction } = await import('../../src/modules/wallets/service.js')
    await ctx.db.transaction(tx => applyWalletTransaction(tx, order.userId, order.walletId!, { type: 'purchase', amountRial: 1,
      referenceType: 'order', referenceId: order.id, idempotencyKey: `fixture-extra:${order.id}` }))
    vi.spyOn(mock, 'createServer').mockRejectedValue(new HetznerApiError(412, 'resource_unavailable', true))
    await handleProvision(ctx, { orderId: order.id })
    expect((await ledgerFor(order.id)).filter(t => t.type === 'refund')).toHaveLength(0)
  })

  it('two concurrent provision attempts create exactly one provider order', async () => {
    const { order } = await buyVps('conc@test.local', 'conc-vps', 'conc-key-1')

    const results = await Promise.all([
      handleProvision(ctx, { orderId: order.id }),
      handleProvision(ctx, { orderId: order.id }),
    ])
    // One worker wins the claim; the loser skips.
    expect(results.some((r) => r.status === 'provisioned')).toBe(true)
    expect(results.filter((r) => r.skipped).length).toBe(1)

    const ops = await ctx.db.query.providerOperations.findMany({
      where: (t) => eq(t.referenceId, order.id),
    })
    expect(ops.length).toBe(1) // unique business key — a second op is impossible

    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(server?.status).toBe('active')
    expect(mock._vpsList().length).toBe(1) // exactly one VPS created at the provider
    expect(mock._postCount()).toBe(1) // exactly one provider POST
  })

  it('a retryable failure retries and eventually provisions without duplicates', async () => {
    const { order } = await buyVps('retry@test.local', 'retry-vps', 'retry-key-1')

    mock.setBehavior({ failNextOrders: 'retryable', failNextOrdersCount: 1 })
    // Handler rethrows retryable errors so BullMQ can retry with backoff.
    await expect(handleProvision(ctx, { orderId: order.id })).rejects.toThrow()
    // Simulate the retry loop: invoke the handler again (op status = failed).
    const second = await handleProvision(ctx, { orderId: order.id })
    expect(second.status).toBe('provisioned')

    const ops = await ctx.db.query.providerOperations.findMany({
      where: (t) => eq(t.referenceId, order.id),
    })
    expect(ops.length).toBe(1)
    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(server?.status).toBe('active')
  })

  it('a permanent provider rejection fails the order and never re-orders', async () => {
    const { order } = await buyVps('perm@test.local', 'perm-vps', 'perm-key-1')

    mock.setBehavior({ failNextOrders: 'permanent', failNextOrdersCount: 1 })
    const result = await handleProvision(ctx, { orderId: order.id })
    expect(result.status).toBe('permanent_failure')

    const op = await ctx.db.query.providerOperations.findFirst({
      where: (t) => eq(t.referenceId, order.id),
    })
    expect(op?.status).toBe('failed')
    const orderRow = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, order.id) })
    expect(orderRow?.status).toBe('failed')

    // A later job run must NOT place the order again.
    const replay = await handleProvision(ctx, { orderId: order.id })
    expect(replay.status).toBe('permanently_failed')
    expect(mock._vpsList().length).toBe(0)
    expect(mock._postCount()).toBe(1) // exactly one provider POST, ever
  })

  it('timeout after provider dispatch -> UNKNOWN -> under review; NO auto-attach, NO re-POST, NO refund', async () => {
    // Capture the wallet BEFORE the purchase so the debit is provable.
    const { user, wallet } = await fundedUser('unknown@test.local')
    const prePurchase = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial
    const quote = await makeMonthlyQuote(user.id)
    const { order } = await createOrderFromQuote(ctx.db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname: 'unknown-vps',
      idempotencyKey: 'unknown-key-1',
    })
    expect(order.status).toBe('paid')
    const afterPurchase = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial
    expect(prePurchase - afterPurchase).toBe(order.totalRial) // captured at purchase

    mock.setBehavior({ timeoutNextOrders: true })
    const result = await handleProvision(ctx, { orderId: order.id })
    expect(result.status).toBe('unknown_scheduled_reconciliation')
    const tracking = (await provisioningRow(ctx.db, user.id, order.id)).tracking
    expect(tracking.failure).toMatchObject({ code: 'outcome_unknown', billing: 'captured', canChooseAlternative: false })
    expect(tracking.failure?.nextStep).toContain('سفارش تازه نسازید')

    // The provider actually created the phantom server; the op is UNKNOWN and
    // the order waits for review — no refund, no second order.
    const op = await ctx.db.query.providerOperations.findFirst({
      where: (t) => eq(t.referenceId, order.id),
    })
    expect(op?.status).toBe('unknown')
    expect(mock._postCount()).toBe(1) // exactly ONE provider POST — no re-POST

    // Reconciliation must NOT auto-attach even though the phantom server
    // exists and its hostname matches the order exactly.
    const res = await handleReconcile(ctx, { operationId: op!.id })
    expect(res.resolved).toBe(0)
    expect(res.underReview).toBe(1)

    const opAfter = await ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.id, op!.id) })
    const recovery = (opAfter!.responseMetadata as Record<string, unknown>).recovery as Record<string, unknown>
    expect(recovery.automaticAttachmentRefused).toBe(true)
    // Candidate evidence IS recorded for the operator.
    expect((recovery.candidateHostnames as string[]).length).toBeGreaterThan(0)

    // No server record, no subscription, order under review, funds untouched.
    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(server).toBeUndefined()
    const orderRow = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, order.id) })
    expect(orderRow?.status).toBe('requires_review')
    // Funds remain captured during UNKNOWN — no automatic refund.
    const still = (await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial
    expect(still).toBe(afterPurchase)

    // A repeated job run on the same UNKNOWN op must not POST again.
    const replay = await handleProvision(ctx, { orderId: order.id })
    expect(replay.status).toBe('unknown_needs_reconciliation')
    expect(mock._postCount()).toBe(1)

    // MANUAL resolution: operator confirms the external server id -> completes.
    const operator = await registerUser(ctx.db, { email: 'operator@test.local', password: 'Pass123456!' })
    const vps = mock._vpsList()[0]!
    await resolveOperationByAdmin(ctx.db, op!.id, { actorId: operator.id, action: 'mark-match', providerServerId: vps.id })
    const serverAfter = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(serverAfter?.status).toBe('active')
    expect(serverAfter?.providerServerId).toBe(vps.id)
  })

  it('single_generic_candidate_is_never_auto_attached', async () => {
    const { order } = await buyVps('single@test.local', 'single-vps', 'single-key-1')

    mock.setBehavior({ timeoutNextOrders: true })
    await handleProvision(ctx, { orderId: order.id })
    const op = await ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.referenceId, order.id) })
    expect(op?.status).toBe('unknown')

    // Provider inventory has EXACTLY ONE plausible VPS — that alone is never
    // proof of ownership.
    expect(mock._vpsList().length).toBe(1)
    const res = await handleReconcile(ctx, { operationId: op!.id })
    expect(res.resolved).toBe(0)
    expect(res.underReview).toBe(1)

    const orderRow = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, order.id) })
    expect(orderRow?.status).toBe('requires_review')
    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(server).toBeUndefined()
  })

  it('hostname matching can never cause cross-customer attachment', async () => {
    // Customer A buys first (normal success).
    const a = await buyVps('h-a@test.local', 'same-host', 'host-a-1')
    const aRes = await handleProvision(ctx, { orderId: a.order.id })
    expect(aRes.status).toBe('provisioned')
    const aServer = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, a.order.id) })
    expect(aServer?.status).toBe('active')

    // Customer B uses the SAME hostname and hits the ambiguous timeout.
    // Provider inventory now holds B's phantom PLUS A's server — both with
    // hostname "same-host".
    const b = await buyVps('host-b@test.local', 'same-host', 'host-b-1')
    mock.setBehavior({ timeoutNextOrders: true })
    const bRes = await handleProvision(ctx, { orderId: b.order.id })
    expect(bRes.status).toBe('unknown_scheduled_reconciliation')
    expect(mock._vpsList().length).toBe(2) // A's server + B's phantom

    const bOp = await ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.referenceId, b.order.id) })
    const recon = await handleReconcile(ctx, { operationId: bOp!.id })
    expect(recon.resolved).toBe(0) // NO auto-attach despite identical hostname

    // A's server is never attached to B's order.
    const bServer = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, b.order.id) })
    expect(bServer).toBeUndefined()
    const bOrder = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, b.order.id) })
    expect(bOrder?.status).toBe('requires_review')
  })

  it('two identical customers -> two independent orders, two provider POSTs, no cross-attachment', async () => {
    const a = await buyVps('idem-a@test.local', 'ident-vps-a', 'identical-a-1')
    const b = await buyVps('idem-b@test.local', 'ident-vps-b', 'identical-b-1')

    const aRes = await handleProvision(ctx, { orderId: a.order.id })
    expect(aRes.status).toBe('provisioned')
    const bRes = await handleProvision(ctx, { orderId: b.order.id })
    expect(bRes.status).toBe('provisioned')

    // Exactly TWO provider POST calls — no pre-order account scan suppressed either.
    expect(mock._postCount()).toBe(2)

    const [opA, opB] = await Promise.all([
      ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.referenceId, a.order.id) }),
      ctx.db.query.providerOperations.findFirst({ where: (t) => eq(t.referenceId, b.order.id) }),
    ])
    expect(opA!.businessKey).not.toBe(opB!.businessKey)

    const [sa, sb] = await Promise.all([
      ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, a.order.id) }),
      ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, b.order.id) }),
    ])
    expect(sa!.providerServerId).not.toBe(sb!.providerServerId)
    // Provider server A cannot be attached to customer B and vice versa.
    await expect(getServerForUser(ctx.db, b.user.id, sa!.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(getServerForUser(ctx.db, a.user.id, sb!.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a prior identical VPS in the account must not suppress a fresh order', async () => {
    // Seed the provider account with an existing VPS that looks like the new
    // customer's order (same product/location/hostname pattern).
    const seed = await buyVps('seed@test.local', 'prior-vps', 'prior-key-1')
    await handleProvision(ctx, { orderId: seed.order.id })
    expect(mock._postCount()).toBe(1)

    // A completely new customer checks out the same offer.
    const fresh = await buyVps('fresh@test.local', 'prior-vps-2', 'fresh-key-1')
    const res = await handleProvision(ctx, { orderId: fresh.order.id })
    expect(res.status).toBe('provisioned')
    // The fresh claimed operation submitted its own POST exactly once.
    expect(mock._postCount()).toBe(2)

    const freshServer = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, fresh.order.id) })
    expect(freshServer?.status).toBe('active')
  })

  it('one user cannot inspect or operate another user\'s server', async () => {
    const a = await buyVps('alice@test.local', 'alice-vps', 'alice-key-1')
    const b = await fundedUser('bob@test.local')

    const res = await handleProvision(ctx, { orderId: a.order.id })
    expect(res.status).toBe('provisioned')
    const server = await ctx.db.query.servers.findFirst({ where: (t) => eq(t.orderId, a.order.id) })
    expect(server).toBeTruthy()

    // Bob cannot read Alice's server.
    await expect(getServerForUser(ctx.db, b.user.id, server!.id)).rejects.toBeInstanceOf(NotFoundError)
    const bobList = await listServersForUser(ctx.db, b.user.id)
    expect(bobList.find((s) => s.id === server!.id)).toBeUndefined()

    // Bob cannot quote/order with Alice's resources either (quote ownership).
    const quote = await makeMonthlyQuote(b.user.id)
    await expect(
      createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: quote.id, walletId: b.wallet.id, hostname: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
