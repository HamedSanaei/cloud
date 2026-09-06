import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { users } from '../../db/schema.js'
import { listSessionsForUser, revokeOtherSessions } from '../auth/service.js'
import { writeAudit } from '../audit/service.js'
import { ValidationError } from '../../lib/errors.js'

const profileSchema = z.object({
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  mobile: z.string().max(30).optional().nullable(),
  nationalCode: z.string().max(20).optional().nullable(),
  timezone: z.string().max(50).optional().nullable(),
})

export const registerUserRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/users/me', async (request) => {
    const user = requireUser(request)
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, user.id) })
    if (!row) throw new ValidationError('کاربر یافت نشد')
    return { data: profileDto(row) }
  })

  app.patch('/users/me', async (request) => {
    const user = requireUser(request)
    const input = parse(profileSchema, request.body)
    const updates: Record<string, unknown> = {}
    if (input.firstName !== undefined) updates.firstName = input.firstName
    if (input.lastName !== undefined) updates.lastName = input.lastName
    if (input.mobile !== undefined) updates.mobile = input.mobile
    if (input.nationalCode !== undefined) updates.nationalCode = input.nationalCode
    if (input.timezone !== undefined) updates.timezone = input.timezone
    updates.updatedAt = new Date()
    await db.update(users).set(updates).where(eq(users.id, user.id))
    await writeAudit(db, { actorId: user.id, action: 'user.profile_updated' })
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, user.id) })
    return { data: profileDto(row!) }
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

  app.patch('/settings/timezone', async (request) => {
    const user = requireUser(request)
    const input = parse(z.object({ timezone: z.string().max(50) }), request.body)
    await db.update(users).set({ timezone: input.timezone, updatedAt: new Date() }).where(eq(users.id, user.id))
    return { data: { ok: true } }
  })
}

function profileDto(row: {
  firstName: string | null
  lastName: string | null
  mobile: string | null
  nationalCode: string | null
  email: string
  timezone: string | null
}) {
  return {
    firstName: row.firstName ?? '',
    lastName: row.lastName ?? '',
    mobile: row.mobile ?? '',
    nationalCode: row.nationalCode ?? '',
    email: row.email,
    legalEnabled: false,
    timezone: row.timezone ?? 'Asia/Tehran',
  }
}