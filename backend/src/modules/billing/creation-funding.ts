import { and, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { orders, servers, subscriptions, wallets } from '../../db/schema.js'
import { InsufficientFundsError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { addInterval } from '../subscriptions/service.js'

export function minimumCreationBalanceRial(totalRial: number, interval: string): number {
  const periods = interval === 'HOURLY' ? 168 : interval === 'DAILY' ? 7 : interval === 'MONTHLY' ? 1 : null
  const required = periods === null ? NaN : totalRial * periods
  if (!Number.isSafeInteger(required) || required <= 0) throw new ValidationError('مبلغ یا دوره سفارش معتبر نیست')
  return required
}

export async function walletCommitments(db: DbOrTx, input: { userId: string; walletId: string }) {
  const now = new Date()
  const horizon = now.getTime() + 7 * 86400000
  // Include queued orders so concurrent purchases cannot reuse the same funds
  // before their subscriptions have been created by the worker.
  const pending = await db.query.orders.findMany({ where: t => and(
    eq(t.userId, input.userId), eq(t.walletId, input.walletId), inArray(t.status, ['paid', 'queued', 'provisioning', 'requires_review']),
  ) })
  let commitments = pending.reduce((sum, order) => sum + minimumCreationBalanceRial(order.totalRial, order.billingInterval) - order.totalRial, 0)
  const existing = await db.select({ subscription: subscriptions }).from(subscriptions)
    .innerJoin(orders, eq(subscriptions.orderId, orders.id))
    .innerJoin(servers, eq(subscriptions.serverId, servers.id))
    .where(and(eq(orders.userId, input.userId), eq(orders.walletId, input.walletId),
      eq(servers.status, 'active'), inArray(subscriptions.status, ['active', 'grace']), eq(orders.status, 'active')))
  for (const { subscription } of existing) {
    let at = Math.max(now.getTime(), subscription.nextInvoiceAt.getTime())
    while (at < horizon) {
      commitments += subscription.priceRial
      at = addInterval(new Date(at), subscription.billingInterval).getTime()
    }
  }
  if (!Number.isSafeInteger(commitments)) throw new ValidationError('تعهد مالی خارج از محدوده است')
  return commitments
}
/** No extra debit/reservation: eligibility is serialized by the payment wallet. */
export async function assertCreationFunding(db: DbOrTx, input: {
  userId: string; walletId: string; totalRial: number; billingInterval: string
}) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, input.walletId)).for('update')
  if (!wallet || wallet.userId !== input.userId) throw new NotFoundError('کیف پول یافت نشد')
  const requiredBalanceRial = minimumCreationBalanceRial(input.totalRial, input.billingInterval) + await walletCommitments(db, input)
  if (!Number.isSafeInteger(requiredBalanceRial)) throw new ValidationError('مبلغ سفارش بیش از حد مجاز است')
  if (wallet.balanceRial < requiredBalanceRial) throw new InsufficientFundsError('موجودی کیف پول شما کافی نیست.', {
    balanceRial: wallet.balanceRial, orderTotalRial: input.totalRial, requiredBalanceRial,
    shortfallRial: requiredBalanceRial - wallet.balanceRial, minimumCoverageDays: 7,
  })
}
