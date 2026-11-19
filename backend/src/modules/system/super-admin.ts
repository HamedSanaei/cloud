import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { adminAuthorizations, users } from '../../db/schema.js'
import type { SessionUser } from '../auth/service.js'
import { verifyPassword } from '../auth/service.js'
import { decryptTotpSecret, verifyTotp } from '../auth/totp.js'
import { isActiveAdmin, isSuperAdmin } from '../../contracts/account-role.js'
import { ConflictError, ForbiddenError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { z } from 'zod'

export const roleChangeInput = z.object({ id: z.uuid(), role: z.enum(['admin', 'super_admin']),
  password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional(), confirm: z.literal(true) }).strict()

const activeSuperAdmin = and(eq(users.role, 'super_admin'), eq(users.status, 'active'))
const lockRoleChanges = (tx: DbOrTx) => tx.execute(sql`select pg_advisory_xact_lock(724519, 1)`)

export const listAdminRoles = (db: DbClient) => db.query.users.findMany({
  where: (t, { and, eq, inArray }) => and(eq(t.status, 'active'), inArray(t.role, ['admin', 'super_admin'])),
  columns: { id: true, email: true, role: true }, orderBy: (t, { asc }) => [asc(t.email), asc(t.id)],
})

export function changeSuperAdmin(db: DbClient, actor: SessionUser, input: z.infer<typeof roleChangeInput>) {
  return db.transaction(async tx => {
    await lockRoleChanges(tx)
    const [account] = await tx.select().from(users).where(eq(users.id, actor.id)).for('update')
    if (!account || !isSuperAdmin(account) || !await verifyPassword(account.passwordHash, input.password)
      || account.twoFactorEnabled && (!input.totp || !account.totpSecretEncrypted || !verifyTotp(decryptTotpSecret(account.totpSecretEncrypted), input.totp))) {
      throw new ForbiddenError('برای تغییر نقش، دسترسی سوپرادمین و رمز فعلی و در صورت فعال بودن، کد دومرحله‌ای معتبر لازم است.')
    }
    const [target] = await tx.select().from(users).where(eq(users.id, input.id)).for('update')
    if (!target || !isActiveAdmin(target)) throw new ConflictError('فقط نقش مدیر فعال قابل تغییر است.')
    if (target.role === input.role) return
    if (input.role === 'admin' && await tx.$count(users, activeSuperAdmin) <= 1) throw new ConflictError('آخرین سوپرادمین فعال قابل تنزل نیست.')
    const now = new Date()
    await tx.update(users).set({ role: input.role, updatedAt: now }).where(eq(users.id, input.id))
    await tx.update(adminAuthorizations).set({ consumedAt: now }).where(and(eq(adminAuthorizations.actorId, target.id), isNull(adminAuthorizations.consumedAt)))
    await writeAudit(tx, { actorId: actor.id, action: 'admin.role_changed', targetType: 'user', targetId: target.id,
      metadata: { before: target.role, after: input.role } })
  })
}

export function bootstrapSuperAdmin(db: DbClient, verifiedAdminEmail: string) {
  return db.transaction(async tx => {
    await lockRoleChanges(tx)
    if (await tx.$count(users, activeSuperAdmin)) throw new ConflictError('An active Super Admin already exists. Use the admin panel.')
    const [target] = await tx.select().from(users).where(eq(users.email, verifiedAdminEmail)).for('update')
    if (target?.role !== 'admin' || target.status !== 'active') throw new ConflictError('Choose an independently verified active administrator.')
    await tx.update(users).set({ role: 'super_admin', updatedAt: new Date() }).where(eq(users.id, target.id))
    await writeAudit(tx, { action: 'admin.super_admin_bootstrapped', targetType: 'user', targetId: target.id,
      metadata: { before: 'admin', after: 'super_admin', source: 'database_operator' } })
  })
}
