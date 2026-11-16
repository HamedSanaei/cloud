import { createHash } from 'node:crypto'
import { and, eq, sql, lte } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { smsOutbox, smsPreferences } from '../../db/schema.js'
import { SMS_CATALOG, smsKeys, renderSms, smsSegments, type SmsKey } from '../auth/parsgreen-templates.js'
import { maskMobile, normalizeIranMobile, sendParsGreenSms, sendSmsOtp } from '../auth/delivery.js'
import { AppError, ConflictError, ProviderUnknownError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { getConfig } from '../../config.js'

export const isAuthSms = (key: SmsKey) => SMS_CATALOG[key].group === 'احراز هویت'
const hashPhone = (phone: string) => createHash('sha256').update(phone).digest('hex')
export const smsPatternHash = (key: SmsKey) => createHash('sha256').update(SMS_CATALOG[key].pattern).digest('hex')
export async function smsPreference(db: DbOrTx, key: SmsKey) {
  const existing = await db.query.smsPreferences.findFirst({ where: t => eq(t.key, key) })
  if (existing) return existing
  await db.insert(smsPreferences).values({ key, enabled: isAuthSms(key), approval: SMS_CATALOG[key].approval, patternHash: smsPatternHash(key) }).onConflictDoNothing()
  return (await db.select().from(smsPreferences).where(eq(smsPreferences.key, key)))[0]!
}
export function smsBlocked(key: SmsKey, preference: { enabled: boolean; approval: string; patternHash: string }) {
  if (!preference.enabled) return 'skipped_disabled'
  if (!SMS_CATALOG[key].ready) return 'blocked_not_implemented'
  if (preference.approval !== 'approved-pattern') return 'blocked_approval'
  if (preference.patternHash !== smsPatternHash(key)) return 'blocked_approval_revision'
  const c = getConfig()
  if (c.AUTH_DELIVERY_MODE !== 'live' || !c.PARSGREEN_SIGNATURE || !c.PARSGREEN_FROM) return 'blocked_configuration'
  return null
}
/** Called inside the business transaction. Disabled events are terminal, never caught up. */
export async function enqueueSms(db: DbOrTx, key: SmsKey, userId: string, eventId: string, values: Record<string, string>) {
  const preference = await smsPreference(db, key)
  const user = await db.query.users.findFirst({ where: t => eq(t.id, userId) })
  let phone = ''
  if (user?.mobileVerifiedAt && user.status === 'active') phone = normalizeIranMobile(user.mobile ?? '') ?? ''
  let status = smsBlocked(key, preference) ?? (phone ? 'pending' : 'skipped_recipient')
  let segments: number | null = null
  try { segments = smsSegments(renderSms(key, values)).segments } catch { status = 'blocked_render' }
  await db.insert(smsOutbox).values({ key, userId, eventId, values, status, segments,
    recipientHash: phone ? hashPhone(phone) : '', maskedRecipient: phone ? maskMobile(phone) : '',
  }).onConflictDoNothing()
}
/** Auth stays synchronous, but uses the same durable independent channel switches. */
export async function assertAuthSmsEnabled(db: DbOrTx, key: SmsKey) {
  const preference = await smsPreference(db, key)
  if (!preference.enabled) throw new AppError(503, 'sms_channel_disabled', 'این روش پیامکی غیرفعال است؛ از ورود یا بازیابی با ایمیل استفاده کنید یا با پشتیبانی تماس بگیرید')
  if (preference.approval !== 'approved-pattern' || preference.patternHash !== smsPatternHash(key)) throw new AppError(503, 'sms_pattern_blocked', 'الگوی پویای این کانال پیامکی تأیید نشده است؛ از مسیر ایمیلی استفاده کنید')
}
export async function deliverAuthSms(db: DbOrTx, key: 'phoneLogin' | 'phoneVerification' | 'passwordRecovery' | 'accountOperation', phone: string, code: string, origin?: string): Promise<{ developmentCode?: string; smsAutofill?: true }> {
  await smsPreference(db, key)
  const outcome = await db.transaction(async tx => {
    await tx.execute(sql`select key from sms_preferences where key = ${key} for share`)
    await assertAuthSmsEnabled(tx, key)
    const message = renderSms(key, { code })
    try {
      const result = key === 'phoneLogin' ? await sendSmsOtp(phone, code, origin) : await sendParsGreenSms(phone, message)
      await writeAudit(tx, { action: getConfig().AUTH_DELIVERY_MODE === 'log' ? 'sms.auth_development' : 'sms.auth_accepted', metadata: { key, recipient: maskMobile(phone), ...smsSegments(message) } })
      return { result }
    } catch (error) {
      await writeAudit(tx, { action: error instanceof ProviderUnknownError ? 'sms.auth_unknown' : 'sms.auth_rejected', metadata: { key, recipient: maskMobile(phone), ...smsSegments(message) } })
      return { error }
    }
  })
  if ('error' in outcome) throw outcome.error
  return outcome.result
}
export async function updateSmsPreference(db: DbOrTx, actorId: string, key: SmsKey, enabled: boolean, version: number, approval?: string) {
  const current = await smsPreference(db, key)
  const [updated] = await db.update(smsPreferences).set({ enabled, approval: approval ?? current.approval, ...(approval !== undefined ? { patternHash: smsPatternHash(key) } : {}), version: version + 1, updatedAt: new Date() })
    .where(and(eq(smsPreferences.key, key), eq(smsPreferences.version, version))).returning()
  if (!updated) throw new ConflictError('تنظیم پیامک تغییر کرده است؛ صفحه را تازه کنید')
  await writeAudit(db, { actorId, action: 'sms.preference_changed', targetType: 'sms_template', metadata: { key, previousEnabled: current.enabled, enabled, previousApproval: current.approval, approval: updated.approval, version: updated.version } })
  return updated
}
export async function smsAdminStatus(db: DbClient) {
  const result = []
  for (const key of smsKeys) {
    const preference = await smsPreference(db, key)
    const history = await db.query.smsOutbox.findMany({ where: t => eq(t.key, key), orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 5,
      columns: { id: true, eventId: true, status: true, maskedRecipient: true, segments: true, createdAt: true, attemptedAt: true, finishedAt: true } })
    if (isAuthSms(key)) {
      const audits = await db.query.auditLogs.findMany({ where: t => and(sql`${t.action} like 'sms.auth_%'`, sql`${t.metadata}->>'key' = ${key}`), orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 5 })
      for (const row of audits) {
        const metadata = row.metadata as Record<string, unknown> | null
        const recipient = typeof metadata?.recipient === 'string' && /^[+*0-9]{4,20}$/.test(metadata.recipient) ? metadata.recipient : ''
        history.push({ id: String(row.id), eventId: `audit:${row.id}`, status: row.action.replace('sms.auth_', ''), maskedRecipient: recipient, segments: Number(metadata?.segments ?? 0), createdAt: row.createdAt, attemptedAt: row.createdAt, finishedAt: row.createdAt })
      }
    }
    result.push({ ...SMS_CATALOG[key], ...preference, blocked: smsBlocked(key, preference), history,
      primaryLine: getConfig().PARSGREEN_PRIMARY_FROM, fallbackConfigured: !!getConfig().PARSGREEN_FROM })
  }
  return result
}
/** At-most-once dispatch. An orphaned sending claim is UNKNOWN, never auto-replayed. */
export async function dispatchSms(db: DbClient, send = sendParsGreenSms, limit = 5) {
  const expired = new Date(Date.now() - 5 * 60000)
  await db.update(smsOutbox).set({ status: 'unknown', finishedAt: new Date() }).where(and(eq(smsOutbox.status, 'sending'), lte(smsOutbox.attemptedAt, expired)))
  for (let i = 0; i < limit; i++) {
    const claimed = await db.transaction(async tx => {
      const [row] = await tx.select().from(smsOutbox).where(eq(smsOutbox.status, 'pending')).orderBy(smsOutbox.createdAt).for('update', { skipLocked: true }).limit(1)
      if (!row) return null
      await tx.update(smsOutbox).set({ status: 'sending', attemptedAt: new Date() }).where(eq(smsOutbox.id, row.id))
      return row
    })
    if (!claimed) break
    const key = claimed.key as SmsKey
    let status = 'unknown'
    // Shared preference lock serializes toggle commit with the sending boundary.
    // Holding it over the bounded request makes "disabled" completion deterministic.
    await db.transaction(async tx => {
      await tx.execute(sql`select key from sms_preferences where key = ${key} for share`)
      const preference = await smsPreference(tx, key)
      status = smsBlocked(key, preference) ?? ''
      const user = await tx.query.users.findFirst({ where: t => eq(t.id, claimed.userId) })
      let phone = ''
      if (user?.mobileVerifiedAt && user.status === 'active') phone = normalizeIranMobile(user.mobile ?? '') ?? ''
      if (!status && (!phone || hashPhone(phone) !== claimed.recipientHash)) status = 'skipped_recipient'
      if (status) return
      let message: string
      try { message = renderSms(key, claimed.values) } catch { status = 'blocked_render'; return }
      try {
        await send(phone, message, { stopOnUnknown: true })
        status = 'accepted' // No handset DLR exists in this API response.
      } catch (error) { status = error instanceof ProviderUnknownError ? 'unknown' : 'rejected' }
    })
    await db.update(smsOutbox).set({ status, finishedAt: new Date() }).where(eq(smsOutbox.id, claimed.id))
  }
}
