import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { users } from '../../src/db/schema.js'
import { getConfig } from '../../src/config.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

// SMS is the first authentication factor for passwordless phone login.
// Email registration and password recovery still require ownership proof.
const skip = !dbAvailable || getConfig().AUTH_DELIVERY_MODE !== 'log'

describe.skipIf(skip)('site-wide single-step sign-in (integration)', () => {
  let app: FastifyInstance
  let ctx: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await ctx?.close()
  })

  it('keeps email verification for signup but signs in immediately with a correct password', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/register/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    expect(start.statusCode).toBe(202)
    const first = start.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: first.challengeToken, code: first.developmentCode } })
    expect(verified.statusCode).toBe(200)

    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/login/start', payload: { email: 'otp@test.local', password: 'wrong' } })
    expect(invalid.statusCode).toBe(401)

    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    expect(signedIn.statusCode).toBe(200)
    const data = signedIn.json<{ data: { token: string; user: { role: string; twoFactorEnabled: boolean }; challengeToken?: string } }>().data
    expect(data.token).toMatch(/^cls_/)
    expect(data.user.role).toBe('user')
    expect(data.user.twoFactorEnabled).toBe(false)
    expect(data.challengeToken).toBeUndefined()
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: 'Bearer ' + data.token } })
    expect(me.statusCode).toBe(200)
  })

  it('does not require TOTP for an admin even with an old two-factor-enabled record', async () => {
    await ctx.db.update(users).set({ role: 'admin', twoFactorEnabled: true }).where(eq(users.email, 'otp@test.local'))
    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    expect(signedIn.statusCode).toBe(200)
    const data = signedIn.json<{ data: { token: string; user: { role: string; twoFactorEnabled: boolean }; challengeToken?: string } }>().data
    expect(data.user.role).toBe('admin')
    expect(data.user.twoFactorEnabled).toBe(false)
    expect(data.challengeToken).toBeUndefined()

    const headers = { authorization: 'Bearer ' + data.token }
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', headers })
    expect(setup.statusCode).toBe(403)
    const enabled = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/enable', headers, payload: { code: '123456' } })
    expect(enabled.statusCode).toBe(403)
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/verify', payload: { token: 'a'.repeat(24), code: '123456' } })
    expect(verify.statusCode).toBe(403)
  })

  it('retains cooldown on password-recovery email challenges', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email: 'otp@test.local' } })
    const token = start.json<{ data: { challengeToken: string } }>().data.challengeToken
    const resend = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/resend', payload: { token } })
    expect(resend.statusCode).toBe(429)
    expect(resend.json<{ error: string }>().error).toBe('cooldown')
  })

  it('requires SMS ownership for phone-only login but no additional TOTP', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(unknown.statusCode).toBe(400)
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/register/phone/start', payload: { mobile: '۰۹۱۲۳۴۵۶۷۸۹', firstName: 'Test' } })
    expect(start.statusCode).toBe(202)
    const challenge = start.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const pending = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(pending.statusCode).toBe(400)
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: challenge.challengeToken, code: challenge.developmentCode } })
    expect(verified.statusCode).toBe(200)
    const user = await ctx.db.query.users.findFirst({ where: t => eq(t.mobile, '+989123456789') })
    expect(user).toBeTruthy()
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, user!.id))

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(login.statusCode).toBe(202)
    const sms = login.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: sms.challengeToken, code: sms.developmentCode } })
    expect(signedIn.statusCode).toBe(200)
    const data = signedIn.json<{ data: { token: string; user: { twoFactorEnabled: boolean }; challengeToken?: string } }>().data
    expect(data.token).toMatch(/^cls_/)
    expect(data.challengeToken).toBeUndefined()
    expect(data.user.twoFactorEnabled).toBe(false)
  })
})
