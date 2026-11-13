import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { chargeRequests, walletPayments } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { applyWalletTransaction, getWallet } from '../wallets/service.js'
import { writeAudit } from '../audit/service.js'
import { GatewayRejected, paymentLink, tabapayRequest, validToken, responseCode } from './tabapay.js'
import { effectiveGateway, gatewayLock } from '../system/gateway.js'
import { publishNotification } from '../notifications/service.js'

export function paymentDto(payment: typeof walletPayments.$inferSelect) {
  return { id: payment.id, walletId: payment.walletId, amountRial: payment.amountRial, status: payment.status,
    paymentUrl: payment.status === 'pending' && payment.gatewayToken ? paymentLink(payment.gatewayToken, payment.sandbox) : null }
}
export async function createRecharge(db: DbClient, userId: string, walletId: string, amountRial: number, key: string) {
  if (!Number.isSafeInteger(amountRial) || amountRial < 100000 || amountRial > 500000000) throw new ValidationError('مبلغ شارژ مجاز نیست.')
  await getWallet(db, userId, walletId)
  const attempt = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recharge:${userId}:${key}`}, 0))`)
    const previous = await tx.query.walletPayments.findFirst({ where: t => and(eq(t.userId, userId), eq(t.idempotencyKey, key)) })
    if (previous) {
      if (previous.amountRial !== amountRial || previous.walletId !== walletId) throw new ConflictError('این کلید قبلاً برای درخواست دیگری استفاده شده است.')
      return { payment: previous, created: false, merchant: '' }
    }
    await gatewayLock(tx)
    const gateway = await effectiveGateway(tx)
    if (!gateway.enabled || !validToken(gateway.merchant)) throw new AppError(503, 'payment_gateway_unavailable', 'درگاه شارژ کیف پول پیکربندی نشده است.')
    const id = randomUUID()
    const [charge] = await tx.insert(chargeRequests).values({ userId, number: `PAY-${id}`, amountRial, status: 'processing' }).returning()
    const [payment] = await tx.insert(walletPayments).values({ id, userId, walletId, chargeRequestId: charge!.id,
      idempotencyKey: key, amountRial, sandbox: gateway.sandbox, merchantFingerprint: gateway.fingerprint }).returning()
    await writeAudit(tx, { actorId: userId, action: 'wallet.recharge_created', targetType: 'wallet_payment', targetId: id, metadata: { amountRial, walletId } })
    return { payment: payment!, created: true, merchant: gateway.merchant }
  })
  if (!attempt.created) return paymentDto(attempt.payment)
  const payment = attempt.payment
  let result: Record<string, unknown>
  try {
    result = await tabapayRequest('create', { amount: String(amountRial),
      callbackURL: new URL('/api/v1/payments/tabapay/callback', getConfig().FRONTEND_URL).href,
      additionalData: JSON.stringify({ paymentId: payment.id }) }, payment.sandbox, attempt.merchant)
    if (responseCode(result.responseCode) !== 1 || result.status !== 'success' || !validToken(result.token) || result.url !== paymentLink(result.token, payment.sandbox)) {
      throw new Error('invalid creation response')
    }
  } catch (error) {
    await db.transaction(async tx => {
      const failed = error instanceof GatewayRejected
      await tx.update(walletPayments).set({ status: failed ? 'failed' : 'unknown', updatedAt: new Date() }).where(eq(walletPayments.id, payment.id))
      await tx.update(chargeRequests).set({ status: failed ? 'rejected' : 'processing', updatedAt: new Date() }).where(eq(chargeRequests.id, payment.chargeRequestId))
      await notifyRechargeIssue(tx, payment, failed)
      await writeAudit(tx, { actorId: userId, action: 'payment.create_failed', targetType: 'wallet_payment', targetId: payment.id, metadata: { code: error instanceof AppError ? error.code : 'unknown', result: failed ? 'rejected' : 'unknown' } })
    })
    // The durable attempt remains available to the owner for tracking. No blind retry.
    return paymentDto({ ...payment, status: error instanceof GatewayRejected ? 'failed' : 'unknown' })
  }
  const [pending] = await db.update(walletPayments).set({ status: 'pending', gatewayToken: String(result.token).toLowerCase(), updatedAt: new Date() })
    .where(eq(walletPayments.id, payment.id)).returning()
  return paymentDto(pending!)
}
export async function verifyRecharge(db: DbClient, id: string) {
  const payment = await db.query.walletPayments.findFirst({ where: t => eq(t.id, id) })
  if (!payment) throw new NotFoundError('درخواست پرداخت یافت نشد.')
  if (payment.status === 'succeeded' || payment.status === 'failed' || !payment.gatewayToken) return paymentDto(payment)
  const credential = await effectiveGateway(db, payment.merchantFingerprint)
  // Issuer verification uses the frozen amount, never callback/browser claims.
  const result = await tabapayRequest('verify', { token: payment.gatewayToken, amount: String(payment.amountRial) }, payment.sandbox, credential.merchant)
  const matching = result.token === payment.gatewayToken && String(result.amount) === String(payment.amountRial)
  const reference = result.shaparakRefNumber
  const success = matching && [1, 2].includes(responseCode(result.responseCode) ?? 0) && result.status === 'success' &&
    typeof reference === 'string' && /^[0-9]{1,100}$/.test(reference) && !/^0+$/.test(reference)
  if (!success) {
    if (matching && responseCode(result.responseCode) === -102 && result.status === 'error') {
      await db.transaction(async tx => {
        const [locked] = await tx.select().from(walletPayments).where(eq(walletPayments.id, id)).for('update')
        if (!locked || ['succeeded', 'failed'].includes(locked.status)) return
        await tx.update(walletPayments).set({ status: 'failed', updatedAt: new Date() }).where(eq(walletPayments.id, id))
        await tx.update(chargeRequests).set({ status: 'rejected', updatedAt: new Date() }).where(eq(chargeRequests.id, payment.chargeRequestId))
        await notifyRechargeIssue(tx, payment, true)
      })
    }
  } else await db.transaction(async tx => {
    const [locked] = await tx.select().from(walletPayments).where(eq(walletPayments.id, id)).for('update')
    if (locked!.status === 'succeeded') return
    await applyWalletTransaction(tx, payment.userId, payment.walletId, { type: 'deposit', amountRial: payment.amountRial,
      referenceType: 'tabapay', referenceId: payment.id, idempotencyKey: `tabapay:${payment.id}`, description: 'شارژ کیف پول با تاباپی' })
    await tx.update(walletPayments).set({ status: 'succeeded', providerReference: reference as string, updatedAt: new Date() }).where(eq(walletPayments.id, id))
    await tx.update(chargeRequests).set({ status: 'approved', invoiceNumber: reference as string, updatedAt: new Date() }).where(eq(chargeRequests.id, payment.chargeRequestId))
    await writeAudit(tx, { actorId: payment.userId, action: 'wallet.recharge_verified', targetType: 'wallet_payment', targetId: id,
      metadata: { amountRial: payment.amountRial, walletId: payment.walletId, reference } })
  })
  return paymentDto((await db.query.walletPayments.findFirst({ where: t => eq(t.id, id) }))!)
}

function notifyRechargeIssue(db: Parameters<typeof publishNotification>[0], payment: typeof walletPayments.$inferSelect, failed: boolean) {
  return publishNotification(db, { userId: payment.userId, eventKey: `payment:${payment.id}:${failed ? 'failed' : 'unknown'}`,
    title: failed ? 'پرداخت شارژ کیف پول ناموفق بود' : 'وضعیت پرداخت شارژ کیف پول نامشخص است',
    body: `جزئیات درخواست پرداخت ${payment.id} را در بخش درخواست‌های شارژ بررسی کنید.`,
    href: '/charge-requests', type: failed ? 'error' : 'warning' })
}
