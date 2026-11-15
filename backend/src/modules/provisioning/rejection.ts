import { and, eq, inArray, lt } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { invoices, orderEvents, orders, providerOperations, users, walletTransactions, wallets } from '../../db/schema.js'
import { creditWallet, getWallet } from '../wallets/service.js'
import { publishNotification } from '../notifications/service.js'
import { writeAudit } from '../audit/service.js'

/** Only persisted proof of a definitive rejection permits automatic settlement.
 * Legacy failures and unknown outcomes intentionally require operator review. */
export async function settleRejectedProvision(db: DbClient, operationId: string) {
  const snapshot = await db.query.providerOperations.findFirst({ where: t => eq(t.id, operationId) })
  const owner = snapshot && await db.query.orders.findFirst({ where: t => eq(t.id, snapshot.referenceId) })
  if (!snapshot || !owner) return false
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('no key update')
    const [order] = await tx.select().from(orders).where(eq(orders.id, owner.id)).for('update')
    const [operation] = await tx.select().from(providerOperations).where(eq(providerOperations.id, operationId)).for('update')
    const meta = operation?.responseMetadata as Record<string, unknown> | null
    if (!order || order.userId !== owner.userId || !operation || operation.referenceId !== order.id || operation.kind !== 'provision' || operation.referenceType !== 'order' || operation.provider !== order.provider
      || operation.status !== 'failed' || meta?.permanent !== true || meta.definitiveRejection !== true) return false
    if (order.status === 'refunded') return true
    if (order.status !== 'failed' || order.currency !== 'IRR' || !order.walletId) return false
    if (await tx.query.servers.findFirst({ where: t => eq(t.orderId, order.id) })
      || await tx.query.subscriptions.findFirst({ where: t => eq(t.orderId, order.id) })) return false
    const wallet = await getWallet(tx, order.userId, order.walletId)
    // Serialize with every normal ledger writer before reading the settlement evidence.
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, wallet.id)).for('update')
    const debits = await tx.select().from(walletTransactions).where(and(eq(walletTransactions.userId, order.userId),
      eq(walletTransactions.referenceId, order.id), eq(walletTransactions.referenceType, 'order'), eq(walletTransactions.type, 'purchase'), lt(walletTransactions.amountRial, 0))).limit(2)
    const debit = debits[0]
    if (debits.length !== 1 || !debit || -debit.amountRial !== order.totalRial
      || (await getWallet(tx, order.userId, debit.walletId)).id !== wallet.id) return false
    // Do not issue a second credit if an operator already refunded this order.
    if (await tx.query.walletTransactions.findFirst({ where: t => and(eq(t.userId, order.userId), eq(t.referenceId, order.id),
      eq(t.referenceType, 'order'), eq(t.type, 'refund')) })) return false
    const refund = await creditWallet(tx, order.userId, wallet.id, -debit.amountRial, { type: 'refund', referenceType: 'order', referenceId: order.id,
      idempotencyKey: `provision-refund:${operation.id}`, description: `بازگشت وجه سفارش ناموفق ${order.orderNumber}`,
      metadata: { operationId: operation.id, debitId: debit.id } })
    const now = new Date()
    await tx.update(orders).set({ status: 'refunded', updatedAt: now }).where(eq(orders.id, order.id))
    await tx.update(providerOperations).set({ responseMetadata: { ...meta, refundId: refund.transaction.id }, updatedAt: now }).where(eq(providerOperations.id, operation.id))
    await tx.update(invoices).set({ status: 'void' }).where(and(eq(invoices.orderId, order.id), inArray(invoices.status, ['paid', 'open'])))
    await tx.insert(orderEvents).values({ orderId: order.id, fromStatus: 'failed', toStatus: 'refunded',
      reason: 'definitive provider rejection; captured payment returned', metadata: { operationId: operation.id, refundId: refund.transaction.id } })
    await writeAudit(tx, { actorId: order.userId, action: 'provider.order.refunded', targetType: 'order', targetId: order.id,
      metadata: { operationId: operation.id, debitId: debit.id, refundId: refund.transaction.id, amountRial: -debit.amountRial } })
    await publishNotification(tx, { userId: order.userId, eventKey: `order:${order.id}:refunded`, title: 'وجه سفارش ناموفق بازگردانده شد',
      body: `ساخت سرور سفارش ${order.orderNumber} توسط سرویس‌دهنده رد شد؛ مبلغ پرداخت‌شده به کیف پول بازگشت.`, href: '/wallet', type: 'info' })
    return true
  })
}
