import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { sessionCookieOptions, AUTH_COOKIE } from '../../app.js'
import { getConfig, isProduction } from '../../config.js'
import { users } from '../../db/schema.js'
import { requireUser } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { ensureDefaultWallet } from '../wallets/service.js'
import { assertCanResend, consumeChallenge, findChallenge, issueChallenge, recordChallengeFailure, verifyChallengeCode, type ChallengeKind } from './challenges.js'
import { maskEmail, maskMobile, normalizeIranMobile, sendEmailOtp, sendSmsOtp } from './delivery.js'
import { beginGoogleOAuth, completeGoogleOAuth } from './google.js'
import { createRecoveryCodes, createTotpSecret, decryptTotpSecret, encryptTotpSecret, buildOtpAuthUri, hashRecoveryCode, verifyTotp } from './totp.js'
import { createSession, hashPassword, login, logout, registerUser, rotateSession, verifyPrimaryCredentials } from './service.js'

const password = z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد').max(200)
const email = z.string().email('ایمیل نامعتبر است').transform((value) => value.trim().toLowerCase())
const otpCode = z.string().regex(/^\d{6}$/, 'کد تأیید باید ۶ رقم لاتین باشد')

const registerSchema = z.object({ email, password, firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), mobile: z.string().max(30).optional() })
const loginSchema = z.object({ email, password: z.string().min(1, 'رمز عبور الزامی است') })
const tokenSchema = z.object({ token: z.string().min(20) })
const verifySchema = tokenSchema.extend({ code: otpCode })
const phoneSchema = z.object({ mobile: z.string().min(10).max(20) })
const resetSchema = verifySchema.extend({ password })
const refreshSchema = z.object({ token: z.string().min(10).optional() })

type RequestMeta = { userAgent?: string; ip?: string }

function meta(request: FastifyRequest): RequestMeta {
  return { userAgent: request.headers['user-agent'], ip: request.ip }
}

async function establishSession(ctx: AppContext, user: typeof users.$inferSelect, request: FastifyRequest, reply: FastifyReply) {
  await ensureDefaultWallet(ctx.db, user.id)
  const session = await createSession(ctx.db, user.id, meta(request))
  reply.setCookie(AUTH_COOKIE, session.token, sessionCookieOptions())
  await writeAudit(ctx.db, { actorId: user.id, action: 'user.login.completed', metadata: { ip: request.ip } })
  return { user: publicUser(user), token: session.token }
}

function challengeResponse(
  challenge: { token: string; expiresIn: number; resendAfter: number },
  type: 'email' | 'sms' | 'totp',
  destination: string,
  developmentCode?: string,
) {
  return {
    challengeToken: challenge.token,
    challengeType: type,
    destination,
    expiresIn: challenge.expiresIn,
    resendAfter: challenge.resendAfter,
    ...(developmentCode ? { developmentCode } : {}),
  }
}

async function deliverChallenge(kind: string, identifier: string, code: string) {
  if (kind === 'phone_login') return sendSmsOtp(identifier, code)
  if (kind === 'email_register') return sendEmailOtp(identifier, code, 'register')
  if (kind === 'password_recovery') return sendEmailOtp(identifier, code, 'recovery')
  return sendEmailOtp(identifier, code, 'login')
}

export const registerAuthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx
  const authLimiter = { max: 20, timeWindow: '1 minute' }
  const sendLimiter = { max: 8, timeWindow: '10 minutes' }

  // Legacy endpoints stay compatible with existing API clients and seed/tests.
  app.post('/auth/register', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    if (isProduction()) throw new BadRequestError('در محیط عملیاتی از مسیر ثبت‌نام تأییدشده استفاده کنید')
    const input = parse(registerSchema, request.body)
    const user = await registerUser(db, input)
    await ensureDefaultWallet(db, user.id)
    await writeAudit(db, { actorId: user.id, action: 'user.registered', metadata: { email: user.email } })
    const session = await login(db, input, meta(request))
    reply.setCookie(AUTH_COOKIE, session.token, sessionCookieOptions())
    return reply.status(201).send({ data: { user: publicUser(session.user), token: session.token } })
  })

  app.post('/auth/login', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    if (isProduction()) throw new BadRequestError('در محیط عملیاتی از ورود چندمرحله‌ای استفاده کنید')
    const input = parse(loginSchema, request.body)
    const session = await login(db, input, meta(request))
    reply.setCookie(AUTH_COOKIE, session.token, sessionCookieOptions())
    return { data: { user: publicUser(session.user), token: session.token } }
  })

  app.post('/auth/register/start', { config: { rateLimit: sendLimiter } }, async (request, reply) => {
    const input = parse(registerSchema, request.body)
    let user = await db.query.users.findFirst({ where: (t) => eq(t.email, input.email) })
    if (user?.status === 'active') throw new ConflictError('این ایمیل قبلاً ثبت شده است')
    const passwordHash = await hashPassword(input.password)
    if (user) {
      const [updated] = await db.update(users).set({ passwordHash, firstName: input.firstName ?? user.firstName, lastName: input.lastName ?? user.lastName, updatedAt: new Date() }).where(eq(users.id, user.id)).returning()
      user = updated
    } else {
      const [created] = await db.insert(users).values({ email: input.email, passwordHash, firstName: input.firstName, lastName: input.lastName, status: 'pending' }).returning()
      user = created
    }
    if (!user) throw new Error('failed to prepare registration')
    const challenge = await issueChallenge(db, { kind: 'email_register', identifier: input.email, userId: user.id })
    const delivery = await sendEmailOtp(input.email, challenge.code, 'register')
    return reply.status(202).send({ data: challengeResponse(challenge, 'email', maskEmail(input.email), delivery.developmentCode) })
  })

  app.post('/auth/login/start', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(loginSchema, request.body)
    const user = await verifyPrimaryCredentials(db, input)
    if (user.twoFactorEnabled) {
      const challenge = await issueChallenge(db, { kind: 'totp', identifier: user.email, userId: user.id })
      return reply.status(202).send({ data: challengeResponse(challenge, 'totp', 'برنامه احراز هویت') })
    }
    const challenge = await issueChallenge(db, { kind: 'email_login', identifier: user.email, userId: user.id })
    const delivery = await sendEmailOtp(user.email, challenge.code, 'login')
    return reply.status(202).send({ data: challengeResponse(challenge, 'email', maskEmail(user.email), delivery.developmentCode) })
  })

  app.post('/auth/phone/start', { config: { rateLimit: sendLimiter } }, async (request, reply) => {
    const input = parse(phoneSchema, request.body)
    const normalized = normalizeIranMobile(input.mobile)
    if (!normalized) throw new BadRequestError('شماره همراه ایرانی معتبر نیست')
    let user = await db.query.users.findFirst({ where: (t) => eq(t.mobile, normalized) })
    if (user?.status === 'disabled') throw new ForbiddenError('این حساب غیرفعال است')
    if (!user) {
      const local = normalized.replace(/\D/g, '')
      const [created] = await db.insert(users).values({
        email: `phone.${local}@accounts.serverhub.invalid`,
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        mobile: normalized,
        status: 'pending',
      }).returning()
      user = created
    }
    if (!user) throw new Error('failed to prepare phone login')
    const challenge = await issueChallenge(db, { kind: 'phone_login', identifier: normalized, userId: user.id })
    const delivery = await sendSmsOtp(normalized, challenge.code)
    return reply.status(202).send({ data: challengeResponse(challenge, 'sms', maskMobile(normalized), delivery.developmentCode) })
  })

  app.post('/auth/challenge/verify', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(verifySchema, request.body)
    const challenge = await verifyChallengeCode(db, input.token, input.code)
    if (!['email_login', 'email_register', 'phone_login'].includes(challenge.kind)) throw new BadRequestError('نوع درخواست تأیید معتبر نیست')
    if (!challenge.userId) throw new BadRequestError('حساب کاربری یافت نشد')
    if (challenge.kind === 'email_register') {
      await db.update(users).set({ status: 'active', emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, challenge.userId))
      await writeAudit(db, { actorId: challenge.userId, action: 'user.email_verified' })
    } else if (challenge.kind === 'phone_login') {
      await db.update(users).set({ status: 'active', mobileVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, challenge.userId))
      await writeAudit(db, { actorId: challenge.userId, action: 'user.mobile_verified' })
    }
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, challenge.userId!) })
    if (!user) throw new BadRequestError('حساب کاربری یافت نشد')
    return { data: await establishSession(ctx, user, request, reply) }
  })

  app.post('/auth/challenge/resend', { config: { rateLimit: sendLimiter } }, async (request, reply) => {
    const input = parse(tokenSchema, request.body)
    const old = await assertCanResend(db, input.token)
    if (!['email_login', 'email_register', 'phone_login', 'password_recovery'].includes(old.kind)) throw new BadRequestError('ارسال مجدد برای این روش امکان‌پذیر نیست')
    const challenge = await issueChallenge(db, {
      kind: old.kind as ChallengeKind,
      identifier: old.identifier,
      userId: old.userId ?? undefined,
      payload: old.payload ?? undefined,
      resendCount: old.resendCount + 1,
    })
    const delivery = await deliverChallenge(old.kind, old.identifier, challenge.code)
    const isSms = old.kind === 'phone_login'
    return reply.status(202).send({ data: challengeResponse(challenge, isSms ? 'sms' : 'email', isSms ? maskMobile(old.identifier) : maskEmail(old.identifier), delivery.developmentCode) })
  })

  app.post('/auth/password/forgot', { config: { rateLimit: sendLimiter } }, async (request, reply) => {
    const input = parse(z.object({ email }), request.body)
    const user = await db.query.users.findFirst({ where: (t) => eq(t.email, input.email) })
    const challenge = await issueChallenge(db, { kind: 'password_recovery', identifier: input.email, userId: user?.id })
    const delivery = user ? await sendEmailOtp(input.email, challenge.code, 'recovery') : {}
    return reply.status(202).send({ data: challengeResponse(challenge, 'email', maskEmail(input.email), delivery.developmentCode) })
  })

  app.post('/auth/password/reset', { config: { rateLimit: authLimiter } }, async (request) => {
    const input = parse(resetSchema, request.body)
    const challenge = await verifyChallengeCode(db, input.token, input.code, 'password_recovery')
    if (challenge.userId) {
      await db.update(users).set({ passwordHash: await hashPassword(input.password), updatedAt: new Date() }).where(eq(users.id, challenge.userId))
      await writeAudit(db, { actorId: challenge.userId, action: 'user.password_reset' })
    }
    return { data: { ok: true } }
  })

  app.post('/auth/2fa/verify', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(verifySchema, request.body)
    const challenge = await findChallenge(db, input.token, 'totp')
    if (!challenge.userId) throw new BadRequestError('حساب کاربری یافت نشد')
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, challenge.userId!) })
    if (!user?.totpSecretEncrypted || !user.twoFactorEnabled) throw new BadRequestError('تأیید دومرحله‌ای برای این حساب فعال نیست')
    if (!verifyTotp(decryptTotpSecret(user.totpSecretEncrypted), input.code)) {
      await recordChallengeFailure(db, challenge.id, challenge.attempts, challenge.maxAttempts)
    }
    if (!(await consumeChallenge(db, challenge.id))) throw new BadRequestError('این درخواست تأیید قبلاً استفاده شده است')
    return { data: await establishSession(ctx, user, request, reply) }
  })

  app.post('/auth/2fa/recovery', { config: { rateLimit: authLimiter } }, async (request, reply) => {
    const input = parse(z.object({ token: z.string().min(20), recoveryCode: z.string().min(8).max(30) }), request.body)
    const challenge = await findChallenge(db, input.token, 'totp')
    if (!challenge.userId) throw new BadRequestError('حساب کاربری یافت نشد')
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, challenge.userId!) })
    const hash = hashRecoveryCode(input.recoveryCode)
    if (!user) throw new BadRequestError('حساب کاربری یافت نشد')
    const codes = user.recoveryCodesHash ?? []
    if (!codes.includes(hash)) await recordChallengeFailure(db, challenge.id, challenge.attempts, challenge.maxAttempts)
    await db.update(users).set({ recoveryCodesHash: codes.filter((item) => item !== hash), updatedAt: new Date() }).where(eq(users.id, user.id))
    if (!(await consumeChallenge(db, challenge.id))) throw new BadRequestError('این درخواست تأیید قبلاً استفاده شده است')
    return { data: await establishSession(ctx, user, request, reply) }
  })

  app.post('/auth/2fa/setup', async (request) => {
    const auth = requireUser(request)
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, auth.id) })
    if (!user) throw new BadRequestError('کاربر یافت نشد')
    if (user.twoFactorEnabled) throw new ConflictError('تأیید دومرحله‌ای از قبل فعال است؛ برای ساخت کلید جدید ابتدا آن را غیرفعال کنید')
    const secret = createTotpSecret()
    const recoveryCodes = createRecoveryCodes()
    await db.update(users).set({ totpSecretEncrypted: encryptTotpSecret(secret), recoveryCodesHash: recoveryCodes.map(hashRecoveryCode), twoFactorEnabled: false, updatedAt: new Date() }).where(eq(users.id, user.id))
    return { data: { secret, otpAuthUri: buildOtpAuthUri(secret, user.email), recoveryCodes } }
  })

  app.post('/auth/2fa/enable', async (request) => {
    const auth = requireUser(request)
    const input = parse(z.object({ code: otpCode }), request.body)
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, auth.id) })
    if (!user?.totpSecretEncrypted || !verifyTotp(decryptTotpSecret(user.totpSecretEncrypted), input.code)) throw new BadRequestError('کد برنامه احراز هویت نامعتبر است')
    await db.update(users).set({ twoFactorEnabled: true, updatedAt: new Date() }).where(eq(users.id, user.id))
    await writeAudit(db, { actorId: user.id, action: 'user.2fa_enabled' })
    return { data: { ok: true } }
  })

  app.post('/auth/2fa/disable', async (request) => {
    const auth = requireUser(request)
    const input = parse(loginSchema.pick({ password: true }), request.body)
    const user = await db.query.users.findFirst({ where: (t) => eq(t.id, auth.id) })
    if (!user) throw new BadRequestError('کاربر یافت نشد')
    await verifyPrimaryCredentials(db, { email: user.email, password: input.password })
    await db.update(users).set({ twoFactorEnabled: false, totpSecretEncrypted: null, recoveryCodesHash: null, updatedAt: new Date() }).where(eq(users.id, user.id))
    await writeAudit(db, { actorId: user.id, action: 'user.2fa_disabled' })
    return { data: { ok: true } }
  })

  app.get('/auth/google/start', { config: { rateLimit: authLimiter } }, async (request) => {
    const query = parse(z.object({ redirectTo: z.string().max(200).optional() }), request.query ?? {})
    return { data: await beginGoogleOAuth(db, query.redirectTo) }
  })

  app.get('/auth/google/callback', async (request, reply) => {
    const query = parse(z.object({ code: z.string().min(1), state: z.string().min(20) }), request.query)
    const result = await completeGoogleOAuth(db, query.code, query.state)
    const session = await establishSession(ctx, result.user, request, reply)
    void session
    return reply.redirect(`${getConfig().FRONTEND_URL}/auth/callback?success=1&redirectTo=${encodeURIComponent(result.redirectTo)}`)
  })

  app.post('/auth/logout', async (request, reply) => {
    const user = request.user
    if (user) await logout(db, user.sessionId)
    reply.clearCookie(AUTH_COOKIE, { path: '/' })
    return { data: { ok: true } }
  })

  app.post('/auth/refresh', async (request, reply) => {
    const input = parse(refreshSchema, request.body ?? {})
    const token = input.token ?? request.cookies?.[AUTH_COOKIE]
    if (!token) throw new BadRequestError('توکن احراز هویت ارسال نشده است')
    const result = await rotateSession(db, token)
    if (!result) throw new BadRequestError('نشست منقضی شده است — دوباره وارد شوید')
    reply.setCookie(AUTH_COOKIE, result.token, sessionCookieOptions())
    return { data: { user: publicUser(result.user), token: result.token } }
  })

  app.get('/auth/me', async (request) => {
    const auth = requireUser(request)
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, auth.id) })
    if (!row) throw new BadRequestError('کاربر یافت نشد')
    return { data: publicUser(row) }
  })
}

function publicUser(u: { id: string; email: string; role: string; status: string; firstName?: string | null; lastName?: string | null; mobile?: string | null; twoFactorEnabled?: boolean }) {
  return { id: u.id, email: u.email.endsWith('@accounts.serverhub.invalid') ? '' : u.email, role: u.role, status: u.status, firstName: u.firstName ?? null, lastName: u.lastName ?? null, mobile: u.mobile ?? null, twoFactorEnabled: u.twoFactorEnabled ?? false }
}
