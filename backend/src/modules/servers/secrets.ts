import { hkdfSync } from 'node:crypto'
import { and, eq, gt, isNull, lte, isNotNull } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { providerOperations, servers, serverSecrets } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { ConflictError } from '../../lib/errors.js'
import type { SessionUser } from '../auth/service.js'
import { writeAudit } from '../audit/service.js'
import { seal, unseal } from '../system/security.js'
import { getServerForUser } from './service.js'

function key() { return Buffer.from(hkdfSync('sha256', getConfig().AUTH_SECRET, 'parserver-server-output-v1', 'temporary-provider-output', 32)) }
export function encryptOutput(value: string, aad: string) { return seal(Buffer.from(value), aad, key()).toString('base64') }
export function decryptOutput(value: string, aad: string) { return unseal(Buffer.from(value, 'base64'), aad, key()).toString('utf8') }
export async function purgeExpiredServerSecrets(db: DbClient) {
  await db.update(serverSecrets).set({ encrypted: null }).where(and(lte(serverSecrets.expiresAt, new Date()), isNotNull(serverSecrets.encrypted)))
}
export async function sealServerSecret(tx: DbOrTx, server: typeof servers.$inferSelect, operation: typeof providerOperations.$inferSelect, value: string) {
  const sessionId = (operation.requestMetadata as { sessionId?: string })?.sessionId
  if (!sessionId) return // System-initiated work cannot expose a password to an arbitrary session.
  const aad = `${server.userId}:${server.id}:${operation.id}`
  await tx.insert(serverSecrets).values({ userId: server.userId, serverId: server.id, sessionId, operationId: operation.id, kind: 'password',
    encrypted: encryptOutput(value, aad), expiresAt: new Date(Date.now() + 5 * 60000) }).onConflictDoNothing()
}
export async function claimServerPassword(db: DbClient, user: SessionUser, serverId: string, operationId: string) {
  const server = await getServerForUser(db, user.id, serverId)
  if (server.terminatedAt) throw new ConflictError('سرور حذف شده است')
  return db.transaction(async tx => {
    const operation = await tx.query.providerOperations.findFirst({ where: t => and(eq(t.id, operationId), eq(t.referenceId, server.id), eq(t.status, 'succeeded')) })
    if (!operation) throw new ConflictError('ابتدا نتیجهٔ نهایی عملیات باید تأیید شود')
    const [secret] = await tx.select().from(serverSecrets).where(and(eq(serverSecrets.operationId, operationId), eq(serverSecrets.userId, user.id), eq(serverSecrets.sessionId, user.sessionId), eq(serverSecrets.kind, 'password'), isNull(serverSecrets.claimedAt), gt(serverSecrets.expiresAt, new Date()))).for('update')
    if (!secret?.encrypted) throw new ConflictError('رمز در این نشست قابل دریافت نیست یا قبلاً مشاهده شده است؛ پس از بررسی وضعیت می‌توانید آن را بازنشانی کنید')
    const password = decryptOutput(secret.encrypted, `${user.id}:${server.id}:${operationId}`)
    await tx.update(serverSecrets).set({ encrypted: null, claimedAt: new Date() }).where(eq(serverSecrets.id, secret.id))
    await writeAudit(tx, { actorId: user.id, action: 'server.password.claimed', targetType: 'server', targetId: server.id, metadata: { operationId } })
    return { password, expiresAt: new Date(Math.min(secret.expiresAt.getTime(), Date.now() + 60000)).toISOString() }
  })
}
