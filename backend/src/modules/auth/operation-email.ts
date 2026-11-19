import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { getConfig } from '../../config.js'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { authChallenges, users } from '../../db/schema.js'
import { requireUser } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { AppError, BadRequestError, ForbiddenError } from '../../lib/errors.js'
import { canonical, digest } from '../system/security.js'
import { consumeChallenge, findChallenge, issueChallenge, verifyChallengeCode } from './challenges.js'
import { maskEmail, sendEmailOtp } from './delivery.js'
import type { SessionUser } from './service.js'

const operationKind = 'server_operation_email'
const accountKind = 'account_email'
const tokenSchema = z.string().regex(/^ch_[a-zA-Z0-9_-]{43}$/)
const codeSchema = z.string().regex(/^\d{6}$/)
export const operationKey = z.string().min(8).max(128)
const intentSchema = z.object({
  action: z.enum(['create', 'create_order', 'pay_order', 'delete', 'reset_password', 'platform_order', 'platform_delete', 'platform_reset_password']),
  key: operationKey, payload: z.record(z.string(), z.unknown()),
}).strict()
export type OperationIntent = z.infer<typeof intentSchema>
export type OperationAuthorization = (tx: DbOrTx) => Promise<void>

async function boundChallenge(db: DbOrTx, user: SessionUser, token: string, kind: typeof operationKind | typeof accountKind) {
  const row = await findChallenge(db, token, kind)
  if (row.userId !== user.id || row.payload?.sessionId !== user.sessionId) throw new ForbiddenError('کد به نشست جاری تعلق ندارد')
  return row
}

export async function authorizeOperation(db: DbClient, user: SessionUser, headers: Record<string, unknown>, intent: OperationIntent): Promise<OperationAuthorization> {
  if (!headers['x-operation-token'] || !headers['x-operation-code']) throw new AppError(403, 'operation_email_required', 'تأیید ایمیلی برای این عملیات لازم است')
  const token = parse(tokenSchema, headers['x-operation-token'])
  const code = parse(codeSchema, headers['x-operation-code'])
  const row = await boundChallenge(db, user, token, operationKind)
  if (row.payload?.intent !== digest(canonical(intent))) throw new ForbiddenError('کد به این درخواست تعلق ندارد')
  await verifyChallengeCode(db, token, code, operationKind, true)
  return async tx => {
    const [account] = await tx.select({ email: users.email, verified: users.emailVerifiedAt, status: users.status }).from(users)
      .where(eq(users.id, user.id)).for('no key update')
    if (!account?.verified || account.status !== 'active' || account.email !== row.payload?.email) throw new ForbiddenError('ایمیل تأییدشدهٔ حساب تغییر کرده است')
    if (!await consumeChallenge(tx, row.id, row.maxAttempts)) throw new BadRequestError('کد مصرف یا منقضی شده است')
  }
}

async function start(db: DbClient, user: SessionUser, kind: typeof operationKind | typeof accountKind, to: string, data: Record<string, unknown>) {
  const identifier = `${kind}:${user.id}`
  const challenge = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identifier}, 0))`)
    const previous = await tx.query.authChallenges.findFirst({
      where: t => and(eq(t.kind, kind), eq(t.identifier, identifier), gt(t.expiresAt, new Date())),
      orderBy: t => [desc(t.createdAt), desc(t.id)],
    })
    const config = getConfig()
    if (previous && (previous.attempts >= previous.maxAttempts || previous.resendCount >= config.AUTH_OTP_MAX_RESENDS)) {
      throw new ForbiddenError('تعداد تلاش یا ارسال به حد مجاز رسیده است؛ پس از پایان اعتبار دوباره تلاش کنید')
    }
    const wait = previous ? Math.ceil((previous.resendAfter.getTime() - Date.now()) / 1000) : 0
    if (wait > 0) throw new AppError(429, 'cooldown', `ارسال دوباره تا ${wait} ثانیهٔ دیگر امکان‌پذیر است`, { retryAfter: wait })
    // Fence a concurrent failed attempt before inheriting the attempt budget.
    const locked = previous ? (await tx.select().from(authChallenges).where(eq(authChallenges.id, previous.id)).for('update'))[0] : undefined
    if (locked && locked.attempts >= locked.maxAttempts) throw new ForbiddenError('تعداد تلاش‌ها به حد مجاز رسیده است')
    return issueChallenge(tx, { kind, identifier, userId: user.id, payload: { sessionId: user.sessionId, email: to, ...data },
      ...(locked ? { attempts: locked.attempts, expiresAt: locked.expiresAt, resendCount: locked.resendCount + 1 } : {}) })
  })
  const issuedAt = Date.now()
  const sent = await sendEmailOtp(to, challenge.code, kind === operationKind ? 'operation' : 'register', challenge.expiresIn)
  const elapsed = Math.floor((Date.now() - issuedAt) / 1000)
  return { token: challenge.token, expiresIn: Math.max(challenge.expiresIn - elapsed, 0),
    resendAfter: Math.max(challenge.resendAfter - elapsed, 0), destination: maskEmail(to), ...sent }
}

export const registerOperationEmail: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx: { db } }) => {
  const rateLimit = { max: 10, timeWindow: '1 minute' }
  app.post('/auth/operation-email/start', { bodyLimit: 4096, config: { rateLimit } }, async (request, reply) => {
    const user = requireUser(request), intent = parse(intentSchema, request.body)
    const account = await db.query.users.findFirst({ where: t => eq(t.id, user.id) })
    if (!account?.emailVerifiedAt) throw new AppError(403, 'verified_email_required', 'ابتدا ایمیل حساب را در پروفایل تأیید کنید')
    return reply.header('Cache-Control', 'no-store').status(202).send({ data: await start(db, user, operationKind, account.email, { intent: digest(canonical(intent)) }) })
  })
  app.post('/auth/operation-email/cancel', { config: { rateLimit } }, async request => {
    const { token } = parse(z.object({ token: tokenSchema }), request.body)
    const row = await boundChallenge(db, requireUser(request), token, operationKind)
    return { data: { cancelled: await consumeChallenge(db, row.id) } }
  })
  app.post('/auth/account-email/start', { config: { rateLimit } }, async (request, reply) => {
    const user = requireUser(request), { email } = parse(z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) }), request.body)
    const account = await db.query.users.findFirst({ where: t => eq(t.id, user.id) })
    if (account?.emailVerifiedAt) throw new ForbiddenError('حساب از قبل ایمیل تأییدشده دارد')
    return reply.header('Cache-Control', 'no-store').status(202).send({ data: await start(db, user, accountKind, email, {}) })
  })
  app.post('/auth/account-email/verify', { config: { rateLimit } }, async request => {
    const user = requireUser(request), { token, code } = parse(z.object({ token: tokenSchema, code: codeSchema }), request.body)
    const row = await boundChallenge(db, user, token, accountKind)
    await verifyChallengeCode(db, token, code, accountKind, true)
    await db.transaction(async tx => {
      const [account] = await tx.select({ verified: users.emailVerifiedAt }).from(users).where(eq(users.id, user.id)).for('no key update')
      if (!account || account.verified || !await consumeChallenge(tx, row.id, row.maxAttempts)) throw new BadRequestError('درخواست تأیید دیگر معتبر نیست')
      const email = String(row.payload?.email)
      const owner = await tx.query.users.findFirst({ columns: { id: true }, where: t => eq(t.email, email) })
      if (owner && owner.id !== user.id) throw new BadRequestError('ثبت این ایمیل امکان‌پذیر نیست')
      try { await tx.update(users).set({ email, emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id)) }
      catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') throw new BadRequestError('ثبت این ایمیل امکان‌پذیر نیست')
        throw error
      }
    })
    return { data: { verified: true } }
  })
}
