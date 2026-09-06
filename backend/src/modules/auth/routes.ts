import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { sessionCookieOptions, AUTH_COOKIE } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { eq } from 'drizzle-orm'
import { login, logout, registerUser, rotateSession } from './service.js'
import { ensureDefaultWallet } from '../wallets/service.js'
import { writeAudit } from '../audit/service.js'
import { BadRequestError } from '../../lib/errors.js'

const registerSchema = z.object({
  email: z.string().email('ایمیل نامعتبر است'),
  password: z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد').max(200),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  mobile: z.string().max(30).optional(),
})

const loginSchema = z.object({
  email: z.string().email('ایمیل نامعتبر است'),
  password: z.string().min(1, 'رمز عبور الزامی است'),
})

const refreshSchema = z.object({
  token: z.string().min(10).optional(),
})

export const registerAuthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  // Login rate limit is tightened relative to the global one.
  const authLimiter = { max: 20, timeWindow: '1 minute' }

  app.post('/auth/register', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(registerSchema, request.body)
    const user = await registerUser(db, input)
    await ensureDefaultWallet(db, user.id)
    await writeAudit(db, { actorId: user.id, action: 'user.registered', metadata: { email: user.email } })

    const { login: doLogin } = await import('./service.js')
    const session = await doLogin(db, { email: input.email, password: input.password }, { userAgent: request.headers['user-agent'], ip: request.ip })
    reply.setCookie(AUTH_COOKIE, session.token, sessionCookieOptions())
    return reply.status(201).send({ data: { user: publicUser(session.user), token: session.token } })
  })

  app.post('/auth/login', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(loginSchema, request.body)
    const session = await login(db, input, { userAgent: request.headers['user-agent'], ip: request.ip })
    reply.setCookie(AUTH_COOKIE, session.token, sessionCookieOptions())
    return { data: { user: publicUser(session.user), token: session.token } }
  })

  app.post('/auth/logout', async (request, reply) => {
    const user = request.user
    if (user) await logout(db, user.sessionId)
    reply.clearCookie(AUTH_COOKIE, { path: '/' })
    return { data: { ok: true } }
  })

  app.post('/auth/refresh', async (request) => {
    const input = parse(refreshSchema, request.body ?? {})
    const token = input.token ?? request.cookies?.[AUTH_COOKIE]
    if (!token) throw new BadRequestError('توکن احراز هویت ارسال نشده است')
    const result = await rotateSession(db, token)
    if (!result) throw new BadRequestError('نشست منقضی شده است — دوباره وارد شوید')
    return { data: { user: publicUser(result.user), token: result.token } }
  })

  app.get('/auth/me', async (request) => {
    const user = requireUser(request)
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, user.id) })
    if (!row) throw new BadRequestError('کاربر یافت نشد')
    return { data: publicUser(row) }
  })
}

function publicUser(u: { id: string; email: string; role: string; status: string }) {
  return { id: u.id, email: u.email, role: u.role, status: u.status }
}