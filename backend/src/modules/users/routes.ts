import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { sessions, users } from '../../db/schema.js'
import { listSessionsForUser, revokeOtherSessions } from '../auth/service.js'
import { writeAudit } from '../audit/service.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { normalizeIranMobile } from '../../contracts/iran-mobile.js'
import { internalEmail } from '../auth/email-address.js'

const profileSchema = z.object({
  firstName: z.string().max(100, 'نام حداکثر ۱۰۰ نویسه است.').optional().nullable(),
  lastName: z.string().max(100, 'نام خانوادگی حداکثر ۱۰۰ نویسه است.').optional().nullable(),
  mobile: z.string().max(30).optional().nullable(),
  nationalCode: z.string().max(20).optional().nullable(),
  timezone: z.string().max(50).optional().nullable(),
})
const legalProfileSchema = z.object({
  legalEnabled: z.boolean().optional(),
  companyName: z.string().trim().max(250).optional(),
  nationalId: z.string().trim().max(40).optional(),
  registrationNumber: z.string().trim().max(40).optional(),
  economicCode: z.string().trim().max(40).optional(),
})
const compatProfileSchema = profileSchema.omit({ timezone: true }).extend(legalProfileSchema.shape)

export const registerUserRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  const readProfile = async (request: FastifyRequest) => {
    const user = requireUser(request)
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, user.id) })
    if (!row) throw new ValidationError('کاربر یافت نشد')
    return { data: profileDto(row) }
  }
  app.get('/users/me', readProfile)
  app.get('/profile', readProfile)

  const update = async (userId: string, input: z.infer<typeof profileSchema>, legal?: z.infer<typeof legalProfileSchema>) => {
    const mobile = typeof input.mobile === 'string' ? normalizeIranMobile(input.mobile) ?? (input.mobile.trim() || null) : input.mobile
    const [row] = await db.update(users).set({
      ...input, mobile,
      mobileVerifiedAt: mobile === undefined ? undefined : sql`case when ${users.mobile} is distinct from ${mobile} then null else ${users.mobileVerifiedAt} end`,
      legalProfile: legal && Object.values(legal).some(value => value !== undefined) ? sql`coalesce(${users.legalProfile}, '{}'::jsonb) || ${JSON.stringify(legal)}::jsonb` : undefined,
      updatedAt: new Date(),
    }).where(eq(users.id, userId)).returning()
    if (!row) throw new NotFoundError('کاربر یافت نشد')
    await writeAudit(db, { actorId: userId, action: 'user.profile_updated' })
    return { data: profileDto(row) }
  }
  app.patch('/users/me', async request => update(requireUser(request).id, parse(profileSchema, request.body)))
  app.put('/profile', async request => {
    const { legalEnabled, companyName, nationalId, registrationNumber, economicCode, ...input } = parse(compatProfileSchema, request.body)
    return update(requireUser(request).id, input, { legalEnabled, companyName, nationalId, registrationNumber, economicCode })
  })

  app.get('/sessions', async (request) => {
    const user = requireUser(request)
    const rows = await listSessionsForUser(db, user.id, user.sessionId)
    return {
      data: rows.map((s) => ({
        id: s.id,
        device: s.userAgent,
        location: s.ip || 'Asia/Tehran',
        lastActivity: s.lastActivity.toISOString(),
        current: s.current,
      })),
    }
  })

  app.delete('/sessions/others', async (request) => {
    const user = requireUser(request)
    const revoked = await revokeOtherSessions(db, user.id, user.sessionId)
    await writeAudit(db, { actorId: user.id, action: 'user.sessions_revoked', metadata: { revoked } })
    return { data: { revoked } }
  })
  app.delete('/sessions/:id', async request => {
    const user = requireUser(request), { id } = parse(z.object({ id: z.uuid() }), request.params)
    const [revoked] = await db.update(sessions).set({ revokedAt: new Date() }).where(and(
      eq(sessions.id, id), eq(sessions.userId, user.id), ne(sessions.id, user.sessionId),
      isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()),
    )).returning({ id: sessions.id })
    if (!revoked) throw new NotFoundError('نشست قابل پایان یافت نشد')
    await writeAudit(db, { actorId: user.id, action: 'user.session_revoked', metadata: { sessionId: id } })
    return { data: { revoked: true } }
  })

  app.patch('/settings/timezone', async (request) => {
    const user = requireUser(request)
    const input = parse(z.object({ timezone: z.string().max(50) }), request.body)
    await db.update(users).set({ timezone: input.timezone, updatedAt: new Date() }).where(eq(users.id, user.id))
    return { data: { ok: true } }
  })
}

function profileDto(row: typeof users.$inferSelect) {
  return {
    firstName: row.firstName ?? '',
    lastName: row.lastName ?? '',
    mobile: row.mobile ?? '',
    nationalCode: row.nationalCode ?? '',
    email: internalEmail(row.email) ? '' : row.email,
    emailVerified: !internalEmail(row.email) && Boolean(row.emailVerifiedAt),
    emailChangeTotp: row.twoFactorEnabled,
    legalEnabled: false,
    ...row.legalProfile,
    timezone: row.timezone ?? 'Asia/Tehran',
  }
}
