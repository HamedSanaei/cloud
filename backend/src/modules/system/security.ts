import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { adminAuthorizations, users } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import type { SessionUser } from '../auth/service.js'
import { verifyPassword } from '../auth/service.js'
import { decryptTotpSecret, verifyTotp } from '../auth/totp.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
const authorizationDigest = (payload: unknown, account: { passwordHash: string; totpSecretEncrypted: string | null }) => digest(canonical(payload) + ':' + digest(account.passwordHash + ':' + account.totpSecretEncrypted))
export function systemAdmin(user: SessionUser) {
  if (user.role !== 'admin' || user.status !== 'active' || !getConfig().SYSTEM_ADMIN_IDS.split(',').map(v => v.trim()).includes(user.id)) {
    throw new ForbiddenError('این عملیات به مدیر سیستم مجاز نیاز دارد؛ دسترسی باید توسط اپراتور در SYSTEM_ADMIN_IDS تعیین شود.')
  }
}
export function secretKey(value = getConfig().STORE_SECRET_KEY) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new ValidationError('کلید مستقل رمزگذاری سیستم پیکربندی نشده است.')
  return Buffer.from(value, 'hex')
}
export function seal(value: Buffer, aad: string, key = secretKey()): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
}
export function unseal(value: Buffer, aad: string, key = secretKey()): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(value.subarray(-16))
  return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()])
}
export async function issueAuthorization(db: DbClient, user: SessionUser, action: string, payload: unknown, password: string, code: string) {
  systemAdmin(user)
  const row = await db.query.users.findFirst({ where: t => eq(t.id, user.id) })
  if (!row?.twoFactorEnabled || !row.totpSecretEncrypted || !await verifyPassword(row.passwordHash, password) || !verifyTotp(decryptTotpSecret(row.totpSecretEncrypted), code)) {
    await writeAudit(db, { actorId: user.id, action: 'system.step_up_denied' })
    throw new ForbiddenError('رمز عبور و کد برنامهٔ احراز هویت معتبر لازم است. ابتدا احراز هویت دومرحله‌ای را فعال کنید.')
  }
  const [grant] = await db.insert(adminAuthorizations).values({ actorId: user.id, sessionId: user.sessionId, action,
    payloadHash: authorizationDigest(payload, row), expiresAt: new Date(Date.now() + (action === 'backup.download' ? 60000 : 5 * 60000)) }).returning()
  await writeAudit(db, { actorId: user.id, action: 'system.step_up_granted', targetType: 'authorization', targetId: grant!.id, metadata: { operation: action } })
  return { proof: grant!.id, expiresAt: grant!.expiresAt }
}
export async function consumeAuthorization(tx: DbOrTx, user: SessionUser, proof: string, action: string, payload: unknown) {
  systemAdmin(user)
  const [account] = await tx.select().from(users).where(eq(users.id, user.id)).for('share')
  if (!account || account.role !== 'admin' || account.status !== 'active' || !account.twoFactorEnabled) throw new ForbiddenError('دسترسی یا تأیید امنیتی مدیر تغییر کرده است.')
  const [grant] = await tx.select().from(adminAuthorizations).where(eq(adminAuthorizations.id, proof)).for('update')
  if (!grant || grant.actorId !== user.id || grant.sessionId !== user.sessionId || grant.action !== action || grant.payloadHash !== authorizationDigest(payload, account) || grant.consumedAt || grant.expiresAt.getTime() < Date.now()) {
    throw new ForbiddenError('تأیید امنیتی منقضی شده، مصرف شده یا با این عملیات مطابقت ندارد.')
  }
  await tx.update(adminAuthorizations).set({ consumedAt: new Date() }).where(eq(adminAuthorizations.id, proof))
}
