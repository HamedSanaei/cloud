import { eq, sql } from 'drizzle-orm'
import { randomInt } from 'node:crypto'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { invoices, invoiceItems, orderEvents, orderItems, orders } from '../../db/schema.js'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { assertQuoteValid, getQuote, lockQuote, markQuoteAccepted } from '../quotes/service.js'
import { applyWalletTransaction, getWallet } from '../wallets/service.js'
import type { invoiceStatusEnum, orderStatusEnum } from '../../db/schema.js'
import { assertCreationFunding } from '../billing/creation-funding.js'
import { assertProviderPurchaseAllowed } from '../catalog/policy.js'
import { publishNotification } from '../notifications/service.js'

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number]
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number]

// ---------------------------------------------------------------------------
// State machine — never jump arbitrarily between states.
// ---------------------------------------------------------------------------
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['quoted', 'cancelled'],
  quoted: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['queued', 'failed', 'refunded'],
  queued: ['provisioning', 'failed', 'refunded'],
  provisioning: ['active', 'failed', 'requires_review', 'refunded'],
  active: ['requires_review', 'refunded'],
  failed: ['requires_review', 'refunded'],
  cancelled: [],
  requires_review: ['failed', 'refunded', 'active'],
  refunded: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export async function transitionOrder(
  db: DbClient,
  orderId: string,
  to: OrderStatus,
  opts: { actorId?: string | null; reason?: string; metadata?: Record<string, unknown> } = {},
) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update')
    if (!order) throw new NotFoundError('سفارش یافت نشد')
    if (order.status === to) return order
    if (!canTransition(order.status, to)) throw new ConflictError(`انتقال وضعیت سفارش از ${order.status} به ${to} مجاز نیست`)
    await tx.update(orders).set({ status: to, updatedAt: new Date() }).where(eq(orders.id, orderId))
    await tx.insert(orderEvents).values({
      orderId,
      fromStatus: order.status,
      toStatus: to,
      actorId: opts.actorId ?? null,
      reason: opts.reason ?? null,
      metadata: opts.metadata ?? null,
    })
    await notifyOrder(tx, order, to)
    return order
  })
}

async function notifyOrder(db: DbOrTx, order: typeof orders.$inferSelect, status: OrderStatus) {
  const titles = { paid: 'پرداخت سفارش تأیید شد', awaiting_payment: 'سفارش در انتظار پرداخت است',
    failed: 'ایجاد سرور ناموفق بود', requires_review: 'سفارش نیازمند بررسی است', cancelled: 'سفارش لغو شد', refunded: 'وجه سفارش بازگشت داده شد' } as const
  if (!(status in titles)) return
  const title = titles[status as keyof typeof titles]
  await publishNotification(db, { userId: order.userId, eventKey: `order:${order.id}:${status}`, title,
    body: `سفارش ${order.orderNumber} برای سرور «${order.hostname}».`, href: ['paid', 'awaiting_payment', 'cancelled', 'refunded'].includes(status) ? '/invoices' : '/servers',
    type: status === 'failed' ? 'error' : status === 'requires_review' ? 'warning' : status === 'paid' ? 'success' : 'info' })
}

// ---------------------------------------------------------------------------
// Number generation (unique with retry on collision)
// ---------------------------------------------------------------------------
export async function generateNumber(
  db: DbOrTx,
  prefix: string,
  table: typeof orders | typeof invoices,
  column: typeof orders.orderNumber | typeof invoices.invoiceNumber,
): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    const suffix = randomInt(100_000, 1_000_000)
    const candidate = `${prefix}-${stamp}-${suffix}`
    const existing = await db.select({ id: table.id }).from(table).where(eq(column, candidate)).limit(1)
    if (!existing[0]) return candidate
  }
  throw new Error(`failed to generate unique ${prefix} number`)
}

// ---------------------------------------------------------------------------
// Create order from quote (optionally paying immediately from a wallet)
// ---------------------------------------------------------------------------
export interface CreateOrderInput {
  userId: string
  quoteId: string
  walletId?: string
  payFromWallet?: boolean
  hostname: string
  idempotencyKey?: string
}

export async function createOrderFromQuote(db: DbClient, input: CreateOrderInput) {
  let wallet = null
  if (input.walletId || input.payFromWallet) wallet = await getWallet(db, input.userId, input.walletId)

  const result = await db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      // Serialize equal keys before reading a quote (which may already have
      // been accepted by the first request). Never replay another user's order.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`)
      const existing = await tx.query.orders.findFirst({ where: t => eq(t.idempotencyKey, input.idempotencyKey!) })
      if (existing) {
        if (existing.userId !== input.userId) throw new ConflictError('کلید درخواست قبلاً استفاده شده است')
        return { order: existing, created: false }
      }
    }
    const quote = await getQuote(tx, input.userId, input.quoteId)
    await assertQuoteValid(tx, quote)
    await assertProviderPurchaseAllowed(tx, quote.provider, input.userId)
    const hostname = input.hostname.trim() || `vps-${quote.providerProductId.toLowerCase()}-${randomInt(1000, 9999)}`
    if (!/^[a-z0-9][a-z0-9.-]{2,62}$/i.test(hostname)) throw new ValidationError('نام میزبان نامعتبر است')
    if (wallet) await assertCreationFunding(tx, {
      userId: input.userId, walletId: wallet.id, totalRial: quote.totalRial, billingInterval: quote.billingInterval,
    })
    // Single-use guarantee: lock the quote row so two concurrent orders can
    // never consume the same quote.
    const lockedQuote = await lockQuote(tx, quote.id)
    await assertQuoteValid(tx, lockedQuote)
    await markQuoteAccepted(tx, lockedQuote.id)

    const locationRow = lockedQuote.locationId
      ? await tx.query.providerLocations.findFirst({ where: (t) => eq(t.id, lockedQuote.locationId ?? '') })
      : null
    const locationCode = locationRow?.code ?? ''

    const orderNumber = await generateNumber(tx, 'ORD', orders, orders.orderNumber)
    const paying = Boolean(wallet)

    const [order] = await tx
      .insert(orders)
      .values({
        orderNumber,
        userId: input.userId,
        walletId: wallet?.id ?? null,
        quoteId: lockedQuote.id,
        status: paying ? 'paid' : 'awaiting_payment',
        totalRial: lockedQuote.totalRial,
        billingInterval: lockedQuote.billingInterval,
        provider: lockedQuote.provider,
        providerProductId: lockedQuote.providerProductId,
        providerLocation: locationCode,
        hostname,
        operatingSystem: lockedQuote.operatingSystem ?? '',
        billingOption: lockedQuote.billingOption as never,
        idempotencyKey: input.idempotencyKey ?? null,
        paidAt: paying ? new Date() : null,
      })
      .returning()
    if (!order) throw new Error('failed to create order')

    await tx.insert(orderItems).values({
      orderId: order.id,
      kind: 'vps',
      description: `VPS ${lockedQuote.providerProductId} @ ${locationCode} — ${hostname}`,
      quantity: 1,
      unitAmountRial: lockedQuote.totalRial,
      totalRial: lockedQuote.totalRial,
      providerRef: lockedQuote.providerProductId,
      metadata: { quoteId: lockedQuote.id },
    })

    await tx.insert(orderEvents).values({
      orderId: order.id,
      fromStatus: null,
      toStatus: paying ? 'paid' : 'awaiting_payment',
      actorId: input.userId,
      reason: 'order created from quote',
    })

    // Invoice (always created with the order; snapshot = quote).
    const invoiceNumber = await generateNumber(tx, 'INV', invoices, invoices.invoiceNumber)
    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoiceNumber,
        userId: input.userId,
        orderId: order.id,
        status: paying ? 'paid' : 'open',
        subtotalRial: lockedQuote.subtotalRial,
        taxRial: lockedQuote.taxRial,
        discountRial: 0,
        totalRial: lockedQuote.totalRial,
        description: `سفارش ${orderNumber} — VPS ${lockedQuote.providerProductId}`,
        snapshot: { quoteId: lockedQuote.id, fxRate: lockedQuote.fxRate, providerAmountCents: lockedQuote.providerAmountCents },
        issuedAt: new Date(),
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        paidAt: paying ? new Date() : null,
      })
      .returning()
    if (!invoice) throw new Error('failed to create invoice')

    await tx.insert(invoiceItems).values({
      invoiceId: invoice.id,
      description: `VPS ${lockedQuote.providerProductId} @ ${locationCode} (${lockedQuote.billingInterval})`,
      quantity: 1,
      unitAmountRial: lockedQuote.totalRial,
      totalRial: lockedQuote.totalRial,
      referenceType: 'order',
      referenceId: order.id,
    })

    // Debit the wallet exactly once (inside the same transaction).
    if (wallet) {
      await applyWalletTransaction(tx, input.userId, wallet.id, {
        amountRial: lockedQuote.totalRial,
        type: 'purchase',
        referenceType: 'order',
        referenceId: order.id,
        idempotencyKey: input.idempotencyKey ?? `order:${order.id}`,
        description: `پرداخت سفارش ${orderNumber}`,
        metadata: { orderNumber, quoteId: lockedQuote.id },
      })
    }

    await notifyOrder(tx, order, order.status)
    return { order, invoice, created: true }
  })

  if (result.created) await writeAudit(db, {
    actorId: input.userId,
    action: 'order.created',
    targetType: 'order',
    targetId: result.order.id,
    metadata: { orderNumber: result.order.orderNumber, totalRial: result.order.totalRial, paid: Boolean(wallet) },
  })
  return { order: result.order, created: result.created }
}

// ---------------------------------------------------------------------------
// Pay an awaiting_payment order from a wallet
// ---------------------------------------------------------------------------
export async function payOrder(
  db: DbClient,
  input: { userId: string; orderId: string; walletId?: string; idempotencyKey?: string },
) {
  const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, input.orderId) })
  if (!order || order.userId !== input.userId) throw new NotFoundError('سفارش یافت نشد')
  if (order.status === 'paid') return order // already paid — idempotent
  if (order.status !== 'awaiting_payment') throw new ConflictError('این سفارش قابل پرداخت نیست')

  const wallet = await getWallet(db, input.userId, input.walletId)

  const result = await db.transaction(async (tx) => {
    const [txOrder] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for('update')
    if (txOrder?.status === 'paid') return txOrder
    if (!txOrder || txOrder.status !== 'awaiting_payment') throw new ConflictError('این سفارش قابل پرداخت نیست')
    await assertProviderPurchaseAllowed(tx, txOrder.provider, input.userId)
    await assertCreationFunding(tx, { userId: input.userId, walletId: wallet.id, totalRial: txOrder.totalRial, billingInterval: txOrder.billingInterval })

    await applyWalletTransaction(tx, input.userId, wallet.id, {
      amountRial: txOrder.totalRial,
      type: 'purchase',
      referenceType: 'order',
      referenceId: txOrder.id,
      idempotencyKey: input.idempotencyKey ?? `order-pay:${txOrder.id}`,
      description: `پرداخت سفارش ${txOrder.orderNumber}`,
    })

    const [updated] = await tx
      .update(orders)
      .set({ status: 'paid', walletId: wallet.id, paidAt: new Date(), updatedAt: new Date() })
      .where(eq(orders.id, txOrder.id))
      .returning()
    if (!updated) throw new Error('failed to mark order paid')

    await tx.insert(orderEvents).values({
      orderId: txOrder.id,
      fromStatus: 'awaiting_payment',
      toStatus: 'paid',
      actorId: input.userId,
      reason: 'paid from wallet',
    })
    const inv = await tx.query.invoices.findFirst({ where: (t) => eq(t.orderId, txOrder.id) })
    if (inv) {
      await tx.update(invoices).set({ status: 'paid', paidAt: new Date() }).where(eq(invoices.id, inv.id))
    }
    await notifyOrder(tx, updated, 'paid')
    // Return the FRESH row so callers never see the stale awaiting_payment state.
    return updated
  })
  if (!result) throw new Error('failed to pay order')

  await writeAudit(db, {
    actorId: input.userId,
    action: 'order.paid',
    targetType: 'order',
    targetId: result.id,
    metadata: { orderNumber: result.orderNumber, walletId: wallet.id },
  })
  return result
}

export async function cancelUnpaidOrder(db: DbClient, input: { userId: string; orderId: string; actorId?: string }) {
  const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, input.orderId) })
  if (!order || order.userId !== input.userId) throw new NotFoundError('سفارش یافت نشد')
  if (order.status !== 'awaiting_payment' && order.status !== 'quoted' && order.status !== 'draft') {
    throw new ConflictError('فقط سفارش‌های پرداخت‌نشده قابل لغو هستند')
  }
  await transitionOrder(db, order.id, 'cancelled', { actorId: input.actorId ?? input.userId, reason: 'user cancelled' })
  const inv = await db.query.invoices.findFirst({ where: (t) => eq(t.orderId, order.id) })
  if (inv && inv.status === 'open') {
    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, inv.id))
  }
  await writeAudit(db, { actorId: input.userId, action: 'order.cancelled', targetType: 'order', targetId: order.id })
}

export async function listOrders(db: DbClient, userId: string, opts: { limit?: number; offset?: number } = {}) {
  return db.query.orders.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  })
}

export async function getOrder(db: DbClient, userId: string, orderId: string) {
  const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, orderId) })
  if (!order || order.userId !== userId) throw new NotFoundError('سفارش یافت نشد')
  const [items, events] = await Promise.all([
    db.query.orderItems.findMany({ where: (t) => eq(t.orderId, order.id) }),
    db.query.orderEvents.findMany({
      where: (t) => eq(t.orderId, order.id),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
  ])
  return { ...order, items, events }
}

export async function markOrderError(db: DbClient, orderId: string, error: string) {
  await db.update(orders).set({ error, updatedAt: new Date() }).where(eq(orders.id, orderId))
}
