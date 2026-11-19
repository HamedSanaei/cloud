import { safeReturnPath } from '../../contracts/return-path.js'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import type { DbClient } from '../../db/index.js'
import { oauthAccounts, users } from '../../db/schema.js'
import { BadRequestError, ProviderPermanentError, ProviderRetryableError } from '../../lib/errors.js'
import { issueChallenge, findChallenge, consumeChallenge } from './challenges.js'
import { hashPassword } from './service.js'
import { internalEmail } from './email-address.js'

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export async function beginGoogleOAuth(db: DbClient, redirectTo = '/dashboard') {
  const config = getConfig()
  if (!config.GOOGLE_CLIENT_ID) throw new ProviderPermanentError('ورود با گوگل پیکربندی نشده است')
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = await issueChallenge(db, {
    kind: 'google_oauth',
    identifier: `google:${base64url(randomBytes(12))}`,
    code: base64url(randomBytes(16)),
    payload: { verifier, redirectTo: safeReturnPath(redirectTo) },
  })
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state: state.token,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, expiresIn: state.expiresIn }
}

interface GoogleUserInfo {
  sub: string
  email: string
  email_verified: boolean
  given_name?: string
  family_name?: string
}

export async function completeGoogleOAuth(db: DbClient, code: string, state: string) {
  const config = getConfig()
  const challenge = await findChallenge(db, state, 'google_oauth')
  const verifier = typeof challenge.payload?.verifier === 'string' ? challenge.payload.verifier : ''
  if (!verifier) throw new BadRequestError('درخواست ورود گوگل معتبر نیست')

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID,
        ...(config.GOOGLE_CLIENT_SECRET ? { client_secret: config.GOOGLE_CLIENT_SECRET } : {}),
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: config.GOOGLE_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!tokenResponse.ok) throw new Error('google token exchange rejected')
    const token = (await tokenResponse.json()) as { access_token?: string }
    if (!token.access_token) throw new Error('missing access token')

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!profileResponse.ok) throw new Error('google profile rejected')
    const profile = (await profileResponse.json()) as GoogleUserInfo
    if (!profile.sub || !profile.email || !profile.email_verified || internalEmail(profile.email)) throw new BadRequestError('ایمیل حساب گوگل تأیید نشده است')
    if (!(await consumeChallenge(db, challenge.id))) throw new BadRequestError('درخواست ورود گوگل قبلاً استفاده شده است')

    const address = profile.email.toLowerCase()
    const user = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'google:' + profile.sub}, 0))`)
      const linked = await tx.query.oauthAccounts.findFirst({
        where: t => and(eq(t.provider, 'google'), eq(t.providerAccountId, profile.sub)),
      })
      const [account] = await tx.select().from(users).where(linked ? eq(users.id, linked.userId) : eq(users.email, address)).for('update')
      if (linked) {
        // A concurrent email change can revoke the OAuth link while this request waits.
        const stillLinked = await tx.query.oauthAccounts.findFirst({ where: t => eq(t.id, linked.id) })
        if (!stillLinked || !account || account.status === 'disabled') throw new BadRequestError('دسترسی حساب گوگل تغییر کرده است؛ دوباره وارد شوید.')
        return account
      }
      if (account?.status === 'disabled') throw new BadRequestError('این حساب غیرفعال است')
      const resolved = account ?? (await tx.insert(users).values({
        email: address, passwordHash: await hashPassword(base64url(randomBytes(32))), firstName: profile.given_name ?? null,
        lastName: profile.family_name ?? null, emailVerifiedAt: new Date(), status: 'active',
      }).returning())[0]
      if (!resolved) throw new Error('failed to create oauth user')
      await tx.insert(oauthAccounts).values({ userId: resolved.id, provider: 'google', providerAccountId: profile.sub })
      return resolved
    })
    return { user, redirectTo: typeof challenge.payload?.redirectTo === 'string' ? challenge.payload.redirectTo : '/dashboard' }
  } catch (error) {
    if (error instanceof BadRequestError) throw error
    throw new ProviderRetryableError('ورود با گوگل تکمیل نشد؛ دوباره تلاش کنید')
  }
}
