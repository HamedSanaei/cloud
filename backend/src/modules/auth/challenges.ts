import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import type { DbClient } from '../../db/index.js'
import { authChallenges } from '../../db/schema.js'
import { AppError, BadRequestError, ForbiddenError } from '../../lib/errors.js'

export type ChallengeKind = 'email_login' | 'email_register' | 'phone_login' | 'password_recovery' | 'totp' | 'google_oauth'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashCode(id: string, code: string): string {
  return createHmac('sha256', getConfig().AUTH_SECRET).update(`${id}:${code}`).digest('hex')
}

function codeMatches(id: string, expectedHash: string, code: string): boolean {
  const expected = Buffer.from(expectedHash)
  const actual = Buffer.from(hashCode(id, code))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function issueChallenge(
  db: DbClient,
  input: {
    kind: ChallengeKind
    identifier: string
    userId?: string
    payload?: Record<string, unknown>
    resendCount?: number
    code?: string
  },
) {
  const config = getConfig()
  const id = randomUUID()
  const token = `ch_${randomBytes(32).toString('base64url')}`
  const code = input.code ?? String(randomInt(0, 1_000_000)).padStart(6, '0')
  const now = Date.now()

  await db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(authChallenges.kind, input.kind), eq(authChallenges.identifier, input.identifier), isNull(authChallenges.consumedAt)))

  await db.insert(authChallenges).values({
    id,
    tokenHash: hashToken(token),
    codeHash: hashCode(id, code),
    kind: input.kind,
    identifier: input.identifier,
    userId: input.userId ?? null,
    payload: input.payload,
    maxAttempts: config.AUTH_OTP_MAX_ATTEMPTS,
    resendCount: input.resendCount ?? 0,
    expiresAt: new Date(now + config.AUTH_OTP_TTL_SECONDS * 1000),
    resendAfter: new Date(now + config.AUTH_OTP_RESEND_SECONDS * 1000),
  })

  return {
    token,
    code,
    expiresIn: config.AUTH_OTP_TTL_SECONDS,
    resendAfter: config.AUTH_OTP_RESEND_SECONDS,
  }
}

export async function findChallenge(db: DbClient, token: string, kind?: ChallengeKind) {
  const row = await db.query.authChallenges.findFirst({ where: (t) => eq(t.tokenHash, hashToken(token)) })
  if (!row || (kind && row.kind !== kind)) throw new BadRequestError('درخواست تأیید معتبر نیست؛ دوباره از ابتدا تلاش کنید')
  if (row.consumedAt || row.expiresAt <= new Date()) throw new BadRequestError('کد تأیید منقضی شده است؛ کد جدید دریافت کنید')
  if (row.attempts >= row.maxAttempts) throw new ForbiddenError('تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید دریافت کنید')
  return row
}

export async function verifyChallengeCode(db: DbClient, token: string, code: string, kind?: ChallengeKind) {
  const row = await findChallenge(db, token, kind)
  if (!codeMatches(row.id, row.codeHash, code)) {
    const [updated] = await db
      .update(authChallenges)
      .set({ attempts: sql`${authChallenges.attempts} + 1` })
      .where(and(eq(authChallenges.id, row.id), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, new Date())))
      .returning({ attempts: authChallenges.attempts, maxAttempts: authChallenges.maxAttempts })
    if (!updated) throw new BadRequestError('کد تأیید منقضی شده است؛ کد جدید دریافت کنید')
    if (updated.attempts >= updated.maxAttempts) throw new ForbiddenError('تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید دریافت کنید')
    throw new BadRequestError('کد تأیید نامعتبر است', { attemptsRemaining: updated.maxAttempts - updated.attempts })
  }
  const [consumed] = await db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(authChallenges.id, row.id), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, new Date()), sql`${authChallenges.attempts} < ${authChallenges.maxAttempts}`))
    .returning({ id: authChallenges.id })
  if (!consumed) throw new BadRequestError('کد تأیید قبلاً استفاده شده یا منقضی شده است')
  return row
}

export async function consumeChallenge(db: DbClient, challengeId: string): Promise<boolean> {
  const [consumed] = await db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(authChallenges.id, challengeId), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, new Date())))
    .returning({ id: authChallenges.id })
  return Boolean(consumed)
}

export async function recordChallengeFailure(db: DbClient, challengeId: string, attempts: number, maxAttempts: number): Promise<never> {
  const [updated] = await db
    .update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(and(eq(authChallenges.id, challengeId), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, new Date())))
    .returning({ attempts: authChallenges.attempts })
  const next = updated?.attempts ?? attempts + 1
  if (next >= maxAttempts) throw new ForbiddenError('تعداد تلاش‌ها بیش از حد مجاز است؛ دوباره وارد شوید')
  throw new BadRequestError('کد تأیید نامعتبر است', { attemptsRemaining: maxAttempts - next })
}

export async function assertCanResend(db: DbClient, token: string) {
  const row = await findChallenge(db, token)
  const config = getConfig()
  if (row.resendCount >= config.AUTH_OTP_MAX_RESENDS) {
    throw new ForbiddenError('حداکثر تعداد ارسال مجدد انجام شده است؛ کمی بعد دوباره تلاش کنید')
  }
  const waitSeconds = Math.ceil((row.resendAfter.getTime() - Date.now()) / 1000)
  if (waitSeconds > 0) throw new AppError(429, 'cooldown', `ارسال مجدد تا ${waitSeconds} ثانیه دیگر امکان‌پذیر است`, { retryAfter: waitSeconds })
  return row
}
