import { fundingPrice, renewalPrice } from '../pricing/renewal.js'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { orders, servers, settings, subscriptions, wallets } from '../../db/schema.js'
import { AppError, InsufficientFundsError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { addInterval } from '../subscriptions/service.js'
import { defaultCreationCoverageDays, isCreationCoverageDays, minimumCreationPeriods } from '../../contracts/creation-funding.js'
import { writeAudit } from '../audit/service.js'

const coverageKey = 'billing.minimum_creation_coverage_days'
const coverageLock = sql`hashtextextended(${coverageKey}, 0)`

export async function creationCoverageDays(db: DbOrTx, lock = false) {
  if (lock) await db.execute(sql`select pg_advisory_xact_lock_shared(${coverageLock})`)
  const row = await db.query.settings.findFirst({ where: t => eq(t.key, coverageKey) })
  if (!row) return defaultCreationCoverageDays
  if (!isCreationCoverageDays(row.value)) throw new AppError(503, 'funding_policy_unavailable', 'سیاست پوشش کیف پول در دسترس نیست.')
  return row.value
}

export async function setCreationCoverageDays(db: DbClient, actorId: string, minimumCoverageDays: number) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${coverageLock})`)
    const previous = await tx.query.settings.findFirst({ where: t => eq(t.key, coverageKey) })
    const previousDays = previous ? previous.value : defaultCreationCoverageDays
    if (previousDays !== minimumCoverageDays) {
      await tx.insert(settings).values({ key: coverageKey, value: minimumCoverageDays })
        .onConflictDoUpdate({ target: settings.key, set: { value: minimumCoverageDays, updatedAt: new Date() } })
      await writeAudit(tx, { actorId, action: 'billing.creation_coverage_changed', targetType: 'setting',
        metadata: { previousDays, minimumCoverageDays } })
    }
    return { minimumCoverageDays }
  })
}

export function minimumCreationBalanceRial(totalRial: number, interval: string, days = defaultCreationCoverageDays): number {
  const required = totalRial * minimumCreationPeriods(interval, days)
  if (!Number.isSafeInteger(required) || required <= 0) throw new ValidationError('مبلغ یا دوره سفارش معتبر نیست')
  return required
}

export async function walletCommitments(db: DbOrTx, input: { userId: string; walletId: string }, days: number) {
  const now = new Date()
  const horizon = now.getTime() + days * 86400000
  // Include queued orders so concurrent purchases cannot reuse the same funds
  // before their subscriptions have been created by the worker.
  const pending = await db.query.orders.findMany({ where: t => and(
    eq(t.userId, input.userId), eq(t.walletId, input.walletId), inArray(t.status, ['paid', 'queued', 'provisioning', 'requires_review']),
  ) })
  let commitments = 0
  for (const order of pending) {
    // The first interval for a queued order has already been charged.
    const remaining = minimumCreationPeriods(order.billingInterval, days) - 1
    if (remaining <= 0) continue
    const priceRial = order.billingInterval === 'HOURLY'
      ? (await renewalPrice(db, order.id, 'HOURLY', now)).totalRial : order.totalRial
    commitments += priceRial * remaining
  }
  const existing = await db.select({ subscription: subscriptions }).from(subscriptions)
    .innerJoin(orders, eq(subscriptions.orderId, orders.id))
    .innerJoin(servers, eq(subscriptions.serverId, servers.id))
    .where(and(eq(orders.userId, input.userId), eq(orders.walletId, input.walletId),
      eq(servers.status, 'active'), inArray(subscriptions.status, ['active', 'grace']), eq(orders.status, 'active')))
  for (const { subscription } of existing) {
    const priceRial = await fundingPrice(db, subscription)
    let at = Math.max(now.getTime(), subscription.nextInvoiceAt.getTime())
    while (at < horizon) {
      commitments += priceRial
      at = addInterval(new Date(at), subscription.billingInterval).getTime()
    }
  }
  if (!Number.isSafeInteger(commitments)) throw new ValidationError('تعهد مالی خارج از محدوده است')
  return commitments
}
/** No extra debit/reservation: eligibility is serialized by the payment wallet. */
export async function assertCreationFunding(db: DbOrTx, input: {
  userId: string; walletId: string; totalRial: number; billingInterval: string; expectedCoverageDays?: number
}) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.id, input.walletId)).for('update')
  if (!wallet || wallet.userId !== input.userId) throw new NotFoundError('کیف پول یافت نشد')
  const minimumCoverageDays = await creationCoverageDays(db, true)
  if (input.billingInterval !== 'MONTHLY' && input.expectedCoverageDays !== undefined && input.expectedCoverageDays !== minimumCoverageDays) {
    throw new AppError(409, 'funding_policy_changed', 'سیاست پوشش کیف پول تغییر کرد. شرایط تازه را بررسی و دوباره تأیید کنید.', { minimumCoverageDays })
  }
  const requiredBalanceRial = minimumCreationBalanceRial(input.totalRial, input.billingInterval, minimumCoverageDays) +
    await walletCommitments(db, input, minimumCoverageDays)
  if (!Number.isSafeInteger(requiredBalanceRial)) throw new ValidationError('مبلغ سفارش بیش از حد مجاز است')
  if (wallet.balanceRial < requiredBalanceRial) throw new InsufficientFundsError('موجودی کیف پول شما کافی نیست.', {
    balanceRial: wallet.balanceRial, orderTotalRial: input.totalRial, requiredBalanceRial,
    shortfallRial: requiredBalanceRial - wallet.balanceRial, minimumCoverageDays,
  })
}
