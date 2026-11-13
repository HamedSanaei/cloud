import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { authChallenges } from '../../src/db/schema.js'
import { issueChallenge, verifyChallengeCode } from '../../src/modules/auth/challenges.js'
import { dbAvailable, getTestContext, truncateAll } from '../helpers.js'

describe.skipIf(!dbAvailable)('SMS challenge budget and rotation', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  const input = (identifier: string) => ({ kind: 'phone_login' as const, identifier, code: '123456' })
  beforeAll(async () => { ctx = await getTestContext(); await truncateAll(ctx.db) })
  afterAll(async () => { await ctx?.close() })
  it('returns 2, 1, 0 and prevents the correct code and restarts after exhaustion', async () => {
    const challenge = await issueChallenge(ctx.db, input('+989000000011'))
    for (const remaining of [2, 1, 0]) {
      await expect(verifyChallengeCode(ctx.db, challenge.token, '000000')).rejects.toMatchObject({ details: { attemptsRemaining: remaining } })
    }
    await expect(verifyChallengeCode(ctx.db, challenge.token, '123456')).rejects.toMatchObject({ code: 'otp_locked' })
    await expect(issueChallenge(ctx.db, input('+989000000011'))).rejects.toMatchObject({ code: 'otp_locked' })
  })
  it('caps concurrent failures and serializes duplicate sends', async () => {
    const identifier = '+989000000012', challenge = await issueChallenge(ctx.db, input(identifier))
    await Promise.allSettled(Array.from({ length: 8 }, () => verifyChallengeCode(ctx.db, challenge.token, '000000')))
    const row = await ctx.db.query.authChallenges.findFirst({ where: t => eq(t.identifier, identifier) })
    expect(row!.attempts).toBe(3)
    expect(row!.maxAttempts).toBe(3)
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => issueChallenge(ctx.db, input('+989000000013'))))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })
  it('preserves failures and expiry across resend, rejects old tokens and permits one success', async () => {
    const identifier = '+989000000014', first = await issueChallenge(ctx.db, input(identifier))
    await expect(verifyChallengeCode(ctx.db, first.token, '000000')).rejects.toMatchObject({ details: { attemptsRemaining: 2 } })
    const original = (await ctx.db.query.authChallenges.findFirst({ where: t => eq(t.identifier, identifier) }))!
    await ctx.db.update(authChallenges).set({ resendAfter: new Date(0) }).where(eq(authChallenges.id, original.id))
    const second = await issueChallenge(ctx.db, { ...input(identifier), resendToken: first.token })
    await expect(verifyChallengeCode(ctx.db, first.token, '123456')).rejects.toThrow()
    const active = (await ctx.db.select().from(authChallenges).where(eq(authChallenges.identifier, identifier))).find(r => !r.consumedAt)!
    expect(active.expiresAt).toEqual(original.expiresAt)
    expect(active.attempts).toBe(1)
    const results = await Promise.allSettled([verifyChallengeCode(ctx.db, second.token, '123456'), verifyChallengeCode(ctx.db, second.token, '123456')])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })
})
