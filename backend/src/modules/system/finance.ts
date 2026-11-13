import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { adminAdjustments, wallets } from '../../db/schema.js'
import type { SessionUser } from '../auth/service.js'
import { normalizeIranMobile } from '../auth/delivery.js'
import { creditWallet, debitWallet } from '../wallets/service.js'
import { walletCommitments } from '../billing/creation-funding.js'
import { writeAudit } from '../audit/service.js'
import { consumeAuthorization, canonical, systemAdmin } from './security.js'
import { ConflictError, ForbiddenError, InsufficientFundsError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { getConfig } from '../../config.js'

export const adjustmentSchema = z.object({ userId: z.string().uuid(), walletId: z.string().uuid(), direction: z.enum(['credit', 'debit']),
  amountRial: z.number().int().positive().max(1_000_000_000_000), reason: z.string().trim().min(10).max(500), reference: z.string().trim().min(3).max(120), confirm: z.literal(true) }).strict()
export type AdjustmentInput = z.infer<typeof adjustmentSchema>
export async function findFinancialUser(db: DbClient, search: string) {
  const mobile = normalizeIranMobile(search), email = search.trim().toLowerCase()
  if (!mobile && !z.email().safeParse(email).success) throw new ValidationError('شماره موبایل ایرانی یا ایمیل کامل را وارد کنید؛ جست‌وجو دقیق است.')
  const rows = await db.query.users.findMany({ where: t => mobile
    ? sql`regexp_replace(translate(${t.mobile}, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'), '[^0-9+]', '', 'g') in (${mobile}, ${'0' + mobile.slice(3)}, ${mobile.slice(1)})`
    : sql`lower(${t.email}) = ${email}`, limit: 10 })
  return Promise.all(rows.map(async u => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), email: u.email, mobile: u.mobile, status: u.status,
    wallets: (await db.query.wallets.findMany({ where: t => eq(t.userId, u.id) })).map(w => ({ id: w.id, name: w.name, balanceRial: w.balanceRial, isDefault: w.isDefault })) })))
}
async function execute(tx: DbOrTx, adjustment: typeof adminAdjustments.$inferSelect, actorId: string) {
  const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, adjustment.walletId)).for('update')
  if (!wallet || wallet.userId !== adjustment.userId) throw new NotFoundError('کیف پول متعلق به کاربر انتخابی نیست.')
  const after = wallet.balanceRial + (adjustment.direction === 'credit' ? 1 : -1) * adjustment.amountRial
  if (!Number.isSafeInteger(after)) throw new ValidationError('موجودی خارج از محدودهٔ مجاز است.')
  if (adjustment.direction === 'debit' && after < await walletCommitments(tx, adjustment)) throw new InsufficientFundsError('برداشت، موجودی قابل برداشت یا پوشش تعهدات هفت روز آینده را نقض می‌کند.')
  const input = { type: adjustment.direction === 'credit' ? 'manual_credit' as const : 'manual_debit' as const,
    referenceType: 'admin_adjustment', referenceId: adjustment.id, idempotencyKey: `adjustment:${adjustment.id}`,
    description: adjustment.reason, metadata: { adminId: adjustment.actorId, approvedBy: actorId, reference: adjustment.reference } }
  await (adjustment.direction === 'credit' ? creditWallet : debitWallet)(tx, adjustment.userId, adjustment.walletId, adjustment.amountRial, input)
  const [done] = await tx.update(adminAdjustments).set({ status: 'completed', beforeRial: wallet.balanceRial, afterRial: after, completedAt: new Date(), approvedBy: actorId !== adjustment.actorId ? actorId : null })
    .where(eq(adminAdjustments.id, adjustment.id)).returning()
  await writeAudit(tx, { actorId, action: 'system.wallet_adjusted', targetType: 'wallet', targetId: adjustment.walletId,
    metadata: { adjustmentId: adjustment.id, userId: adjustment.userId, amountRial: adjustment.amountRial, direction: adjustment.direction, beforeRial: wallet.balanceRial, afterRial: after, reference: adjustment.reference, reason: adjustment.reason, requestedBy: adjustment.actorId } })
  return done!
}
export async function requestAdjustment(db: DbClient, user: SessionUser, input: AdjustmentInput, key: string, proof: string) {
  systemAdmin(user)
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`adjustment:${user.id}:${key}`}, 0))`)
    const prior = await tx.query.adminAdjustments.findFirst({ where: t => and(eq(t.actorId, user.id), eq(t.key, key)) })
    if (prior) {
      const old = { userId: prior.userId, walletId: prior.walletId, amountRial: prior.amountRial, direction: prior.direction, reason: prior.reason, reference: prior.reference, confirm: true }
      if (canonical(old) !== canonical(input)) throw new ConflictError('این کلید قبلاً برای تعدیل دیگری استفاده شده است.')
      return prior
    }
    await consumeAuthorization(tx, user, proof, 'wallet.adjust', input)
    // Lock BEFORE inserting the wallet FK. Two concurrent FK key-share holders
    // upgrading to FOR UPDATE would otherwise deadlock during ledger execution.
    const [wallet] = await tx.select().from(wallets).where(and(eq(wallets.id, input.walletId), eq(wallets.userId, input.userId))).for('update')
    if (!wallet) throw new NotFoundError('هویت کاربر و کیف پول مطابقت ندارد.')
    const [row] = await tx.insert(adminAdjustments).values({ ...input, actorId: user.id, key }).returning()
    await writeAudit(tx, { actorId: user.id, action: 'system.adjustment_requested', targetType: 'adjustment', targetId: row!.id, metadata: { amountRial: input.amountRial, walletId: input.walletId, direction: input.direction } })
    return input.amountRial >= getConfig().SYSTEM_DUAL_APPROVAL_RIAL ? row! : execute(tx, row!, user.id)
  })
}
export async function approveAdjustment(db: DbClient, user: SessionUser, id: string, proof: string) {
  return db.transaction(async tx => {
    await consumeAuthorization(tx, user, proof, 'wallet.approve', { id, confirm: true })
    const [row] = await tx.select().from(adminAdjustments).where(eq(adminAdjustments.id, id)).for('update')
    if (!row) throw new NotFoundError()
    if (row.actorId === user.id) throw new ForbiddenError('تأیید تعدیل بزرگ باید توسط مدیر دیگری انجام شود.')
    if (row.status === 'completed') return row
    if (row.createdAt.getTime() < Date.now() - 86400000) throw new ConflictError('درخواست تعدیل منقضی شده است؛ درخواست جدید ثبت کنید.')
    return execute(tx, row, user.id)
  })
}
