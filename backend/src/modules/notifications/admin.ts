import type { FastifyInstance } from 'fastify'
import type { DbClient } from '../../db/index.js'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { parse } from '../../http/validate.js'
import { requireAdmin } from '../../http/auth.js'
import { ForbiddenError } from '../../lib/errors.js'
import { smsKeys } from '../auth/parsgreen-templates.js'
import { decryptTotpSecret, verifyTotp } from '../auth/totp.js'
import { verifyPrimaryCredentials } from '../auth/service.js'
import { systemAdmin } from '../system/security.js'
import { isAuthSms, smsAdminStatus, updateSmsPreference } from './sms.js'
import { changeIncident } from './sms-events.js'

/** Inherits system-settings CSRF, active store Super Admin and authority guards. */
export function registerSmsAdmin(app: FastifyInstance, db: DbClient) {
  app.get('/sms', async () => ({ data: await smsAdminStatus(db) }))
  app.post('/sms/:key', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async request => {
    const admin = requireAdmin(request)
    systemAdmin(admin)
    const { key } = parse(z.object({ key: z.enum(smsKeys) }), request.params)
    const input = parse(z.object({ enabled: z.boolean(), version: z.number().int().nonnegative(),
      approval: z.enum(['approved-pattern', 'approved-sample', 'unknown', 'rejected']).optional(),
      confirm: z.literal(true), password: z.string().max(200).optional(), totp: z.string().regex(/^\d{6}$/).optional(),
      confirmation: z.string().optional(),
    }).strict(), request.body)
    if ((isAuthSms(key) && !input.enabled) || input.approval !== undefined) {
      if (!input.password || input.confirmation !== 'تأیید تغییر امنیت پیامک') throw new ForbiddenError('تغییر حساس نیازمند رمز فعلی و عبارت تأیید است؛ بازیابی با ایمیل همچنان در دسترس می‌ماند')
      const account = await db.query.users.findFirst({ where: t => eq(t.id, admin.id) })
      if (!account) throw new ForbiddenError()
      await verifyPrimaryCredentials(db, { email: account.email, password: input.password })
      if (account.twoFactorEnabled && (!input.totp || !account.totpSecretEncrypted || !verifyTotp(decryptTotpSecret(account.totpSecretEncrypted), input.totp))) throw new ForbiddenError('کد تأیید دومرحله‌ای فعلی لازم است')
    }
    return { data: await db.transaction(tx => updateSmsPreference(tx, admin.id, key, input.enabled, input.version, input.approval)) }
  })
  app.post('/sms/incidents/:serverId', async request => {
    const admin = requireAdmin(request)
    const { serverId } = parse(z.object({ serverId: z.string().uuid() }), request.params)
    const input = parse(z.object({ note: z.string().trim().min(1).max(1000), resolved: z.boolean(), confirm: z.literal(true) }).strict(), request.body)
    return { data: await changeIncident(db, admin.id, serverId, input.note, input.resolved) }
  })
}
