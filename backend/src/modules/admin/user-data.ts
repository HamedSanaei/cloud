import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { authChallenges, notifications, oauthAccounts, orders, platformLinks, serverSecrets, servers, sessions, smsOutbox, subscriptions, users, walletPayments, wallets } from '../../db/schema.js'
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { hashPassword, type SessionUser } from '../auth/service.js'
import { isPricingSuperAdmin } from '../system/security.js'

export const isErasedAccount = (email: string) => email.endsWith('@deleted.parserver.invalid')
export const liveServer = sql`${servers.status} <> 'terminated' and ${servers.terminatedAt} is null and ${servers.terminationState} is distinct from 'terminated'`
const unsettledOrders = ['awaiting_payment', 'paid', 'queued', 'provisioning', 'requires_review'] as const

async function deletionBlock(db: DbOrTx, id: string) {
  const [row] = await db.select({
    services: sql<boolean>`exists (select 1 from ${servers} where ${servers.userId} = ${id} and ${liveServer})
      or exists (select 1 from ${subscriptions} where ${subscriptions.userId} = ${id} and ${inArray(subscriptions.status, ['active', 'grace', 'suspended'])})
      or exists (select 1 from ${orders} where ${orders.userId} = ${id} and ${inArray(orders.status, [...unsettledOrders])})`,
    funds: sql<boolean>`exists (select 1 from ${wallets} where ${wallets.userId} = ${id} and ${wallets.balanceRial} <> 0)
      or exists (select 1 from ${walletPayments} where ${walletPayments.userId} = ${id} and ${notInArray(walletPayments.status, ['succeeded', 'failed'])})`,
  }).from(users).where(eq(users.id, id))
  if (row?.services) return 'این حساب سرویس یا سفارش در جریان دارد. ابتدا وضعیت سرویس‌ها را تعیین تکلیف کنید.'
  if (row?.funds) return 'این حساب موجودی یا پرداخت تسویه‌نشده دارد. ابتدا آن را تعیین تکلیف کنید.'
  return null
}

export async function userDataActions(db: DbClient, actor: SessionUser, target: typeof users.$inferSelect) {
  if (!isPricingSuperAdmin(actor) || actor.id === target.id || target.role !== 'user' || isErasedAccount(target.email)) return null
  return { canBlock: target.status !== 'disabled', deleteBlocked: await deletionBlock(db, target.id) }
}

export async function manageUserData(db: DbClient, actor: SessionUser, id: string, action: 'block' | 'delete_data', reason: string) {
  if (!isPricingSuperAdmin(actor) || actor.id === id) throw new ForbiddenError('این عملیات فقط برای سوپرادمین مجاز است')
  const passwordHash = action === 'delete_data' ? await hashPassword(randomUUID()) : undefined
  return db.transaction(async tx => {
    // Serialize account mutations with session issuance, billing and management.
    const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update')
    if (!target) throw new NotFoundError('کاربر یافت نشد')
    if (target.role !== 'user') throw new ForbiddenError('حساب مدیر از این مسیر قابل تغییر نیست')
    if (isErasedAccount(target.email) || action === 'block' && target.status === 'disabled') return { status: 'disabled' }
    const now = new Date()
    if (action === 'delete_data') {
      const reason = await deletionBlock(tx, id)
      if (reason) throw new ConflictError(reason)
      await tx.update(users).set({ status: 'disabled', updatedAt: now, email: `account.${id}@deleted.parserver.invalid`,
        passwordHash, firstName: null, lastName: null, mobile: null, nationalCode: null, legalProfile: null, timezone: null,
        emailVerifiedAt: null, mobileVerifiedAt: null, totpSecretEncrypted: null, recoveryCodesHash: null, twoFactorEnabled: false,
      }).where(eq(users.id, id))
      await tx.delete(sessions).where(eq(sessions.userId, id))
      await tx.delete(oauthAccounts).where(eq(oauthAccounts.userId, id))
      await tx.delete(platformLinks).where(eq(platformLinks.userId, id))
      await tx.delete(notifications).where(eq(notifications.userId, id))
      await tx.delete(serverSecrets).where(eq(serverSecrets.userId, id))
      await tx.delete(authChallenges).where(eq(authChallenges.userId, id))
      await tx.update(smsOutbox).set({ recipientHash: 'erased', maskedRecipient: '—', values: {} }).where(eq(smsOutbox.userId, id))
    } else {
      await tx.update(users).set({ status: 'disabled', updatedAt: now }).where(eq(users.id, id))
      await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
      await tx.update(authChallenges).set({ consumedAt: now }).where(and(eq(authChallenges.userId, id), isNull(authChallenges.consumedAt)))
    }
    await writeAudit(tx, { actorId: actor.id, action: action === 'block' ? 'admin.user_blocked' : 'admin.user_data_deleted', targetType: 'user', targetId: id,
      metadata: { reason } })
    return { status: 'disabled' }
  })
}
