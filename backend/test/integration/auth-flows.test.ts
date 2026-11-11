import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getConfig } from '../../src/config.js'
import { generateTotpCode } from '../../src/modules/auth/totp.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

const skip = !dbAvailable || getConfig().AUTH_DELIVERY_MODE !== 'log'

describe.skipIf(skip)('multi-factor authentication flows (integration)', () => {
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

  it('registers with email OTP and then requires email OTP at password login', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/register/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    expect(start.statusCode).toBe(202)
    const first = start.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: first.challengeToken, code: first.developmentCode } })
    expect(verified.statusCode).toBe(200)
    expect(verified.json<{ data: { token: string } }>().data.token).toMatch(/^cls_/)

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    expect(login.statusCode).toBe(202)
    expect(login.json<{ data: { challengeType: string } }>().data.challengeType).toBe('email')
  })

  it('enforces resend cooldown on email and SMS challenges', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email: 'otp@test.local' } })
    const token = start.json<{ data: { challengeToken: string } }>().data.challengeToken
    const resend = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/resend', payload: { token } })
    expect(resend.statusCode).toBe(429)
    expect(resend.json<{ error: string }>().error).toBe('cooldown')
  })

  it('registers with verified SMS and only allows mobile login after activation', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(unknown.statusCode).toBe(400)
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/register/phone/start', payload: { mobile: '۰۹۱۲۳۴۵۶۷۸۹', firstName: 'Test' } })
    expect(start.statusCode).toBe(202)
    const challenge = start.json<{ data: { challengeToken: string; developmentCode: string; destination: string } }>().data
    expect(challenge.destination).toContain('09123')
    const pending = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(pending.statusCode).toBe(400)
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: challenge.challengeToken, code: challenge.developmentCode } })
    expect(verified.statusCode).toBe(200)
    expect(verified.json<{ data: { user: { mobile: string } } }>().data.user.mobile).toBe('+989123456789')
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/auth/register/phone/start', payload: { mobile: '09123456789' } })
    expect(duplicate.statusCode).toBe(409)
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    expect(login.statusCode).toBe(202)
    const next = login.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const loggedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: next.challengeToken, code: next.developmentCode } })
    expect(loggedIn.statusCode).toBe(200)
  })

  it('requires TOTP after an SMS login when the account has 2FA enabled', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    const sms = start.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: sms.challengeToken, code: sms.developmentCode } })
    const bearer = verified.json<{ data: { token: string } }>().data.token
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', headers: { authorization: 'Bearer ' + bearer } })
    expect(setup.statusCode).toBe(200)
    const secret = setup.json<{ data: { secret: string } }>().data.secret
    const enabled = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/enable', headers: { authorization: 'Bearer ' + bearer }, payload: { code: generateTotpCode(secret) } })
    expect(enabled.statusCode).toBe(200)

    const secondLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/phone/start', payload: { mobile: '09123456789' } })
    const nextSms = secondLogin.json<{ data: { challengeToken: string; developmentCode: string } }>().data
    const nextStep = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge/verify', payload: { token: nextSms.challengeToken, code: nextSms.developmentCode } })
    expect(nextStep.statusCode).toBe(202)
    const secondFactor = nextStep.json<{ data: { challengeType: string; challengeToken: string; token?: string } }>().data
    expect(secondFactor.challengeType).toBe('totp')
    expect(secondFactor.token).toBeUndefined()
    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/verify', payload: { token: secondFactor.challengeToken, code: generateTotpCode(secret) } })
    expect(signedIn.statusCode).toBe(200)
  })

  it('enables TOTP and requires it on the next password login', async () => {
    const legacy = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    const token = legacy.json<{ data: { token: string } }>().data.token
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', headers: { authorization: `Bearer ${token}` } })
    expect(setup.statusCode).toBe(200)
    const secret = setup.json<{ data: { secret: string } }>().data.secret
    const enabled = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/enable', headers: { authorization: `Bearer ${token}` }, payload: { code: generateTotpCode(secret) } })
    expect(enabled.statusCode).toBe(200)

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login/start', payload: { email: 'otp@test.local', password: 'SafePassword123!' } })
    const challenge = login.json<{ data: { challengeToken: string; challengeType: string } }>().data
    expect(challenge.challengeType).toBe('totp')
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/2fa/verify', payload: { token: challenge.challengeToken, code: generateTotpCode(secret) } })
    expect(verify.statusCode).toBe(200)
  })
})
