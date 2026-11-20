import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getTestContext, truncateAll, dbAvailable, testLogger, type TestContext } from '../helpers.js'
import { buildApp } from '../../src/app.js'
import * as config from '../../src/config.js'
import * as delivery from '../../src/modules/auth/delivery.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { users, smsPreferences, smsOutbox, subscriptions, orders } from '../../src/db/schema.js'
import { createSupportTicket, staffTicketAction } from '../../src/modules/tickets/service.js'
import { creditWallet, debitWallet, ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { createOrderFromQuote, payOrder } from '../../src/modules/orders/service.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { getProvider, registerProvider } from '../../src/modules/providers/registry.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { euroMarketSource, setFxRate } from '../../src/modules/pricing/service.js'
import { handleProvision, handleRenewalSweep, handleServerAction } from '../../src/modules/provisioning/handlers.js'
import { PARSGREEN_TEMPLATES, SMS_CATALOG, smsKeys, type SmsKey } from '../../src/modules/auth/parsgreen-templates.js'
import { enqueueSms, dispatchSms, smsPreference, smsPatternHash, updateSmsPreference } from '../../src/modules/notifications/sms.js'
import { changeIncident, sweepSmsEvents } from '../../src/modules/notifications/sms-events.js'
import { ProviderUnknownError } from '../../src/lib/errors.js'

describe.skipIf(!dbAvailable)('durable SMS event producers and dispatcher (no real transport)', () => {
  let ctx: TestContext, app: FastifyInstance, sequence = 0
  const send = vi.fn(async () => ({}))
  beforeAll(async () => {
    ctx = await getTestContext()
    const initial = config.getConfig()
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...initial, DATA_AUTHORITY: 'site', AUTH_DELIVERY_MODE: 'live',
      PARSGREEN_SIGNATURE: 'fixture-only', PARSGREEN_FROM: 'fixture-legacy', PARSGREEN_PRIMARY_FROM: '9998883511' })
    vi.spyOn(delivery, 'sendSmsOtp').mockImplementation(async (_phone, code) => ({ developmentCode: code }))
    vi.spyOn(delivery, 'sendParsGreenSms').mockImplementation(async (_phone, text) => ({ developmentCode: text.match(/\b(\d{6})\b/)?.[1] }))
    // Fail if any unexpected outbound call escapes the mocked providers/transport.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network in SMS regression') }))
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger }); await app.ready()
  })
  beforeEach(async () => {
    await truncateAll(ctx.db); send.mockClear(); ctx.mockProvider.reset()
    await ctx.db.insert(smsPreferences).values(smsKeys.map(key => ({ key, enabled: true, approval: SMS_CATALOG[key].approval, patternHash: smsPatternHash(key) })))
    await setFxRate(ctx.db, '620000', { source: 'market', note: euroMarketSource })
    const mock = ctx.mockProvider
    registerProvider({ ...mock, async syncCatalog() {
      const catalog = await mock.syncCatalog()
      return { ...catalog, offers: catalog.offers.map(o => ({ ...o, category: 'cloud' as const, billingOptions: [{ billingCycle: 'hourly', amount: '0.0055' }, ...o.billingOptions] })) }
    } })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb')); await enableAllOffersForSale(ctx.db)
  })
  afterAll(async () => { await app.close(); await ctx.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  async function account(admin = false) {
    const mobile = `+989${String(++sequence).padStart(9, '0')}`
    const user = await registerUser(ctx.db, { email: `sms-${sequence}@example.test`, password: 'Fixture-password-123!', mobile })
    await ctx.db.update(users).set({ mobile, mobileVerifiedAt: new Date(), role: admin ? 'super_admin' : 'user', status: 'active' }).where(eq(users.id, user.id))
    return (await ctx.db.query.users.findFirst({ where: t => eq(t.id, user.id) }))!
  }
  async function purchase(userId: string, pay = true) {
    const wallet = await ensureDefaultWallet(ctx.db, userId)
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    const quote = await createQuote(ctx.db, { userId, offerId: offer!.id, locationCode: 'FRA-01', billingOption: { billingCycle: 'hourly' }, billingPeriod: 'hourly', operatingSystem: 'ubuntu-24.04' })
    const result = await createOrderFromQuote(ctx.db, { userId, quoteId: quote.id, ...(pay ? { walletId: wallet.id } : {}), hostname: `sms-server-${++sequence}` })
    return { order: result.order, wallet }
  }
  it('drives all 20 business events from committed real application transitions and sends each durable event once', async () => {
    const user = await account(), admin = await account(true), wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 1000000000, { type: 'manual_credit', idempotencyKey: 'initial-credit' })
    const { order } = await purchase(user.id)
    await handleProvision(ctx, { orderId: order.id })
    const server = (await ctx.db.query.servers.findFirst({ where: t => eq(t.orderId, order.id) }))!
    const ticket = await createSupportTicket(ctx.db, user.id, { title: 'Fixture support', department: 'technical', description: 'Fixture' })
    await staffTicketAction(ctx.db, admin.id, ticket.id, { requestId: randomUUID(), reply: 'Confirmed support reply' })
    await staffTicketAction(ctx.db, admin.id, ticket.id, { requestId: randomUUID(), close: true })
    await changeIncident(ctx.db, admin.id, server.id, 'Confirmed fixture incident', false)
    await changeIncident(ctx.db, admin.id, server.id, 'Resolved fixture incident', true)
    await creditWallet(ctx.db, user.id, wallet.id, 100, { type: 'refund', referenceType: 'order', referenceId: order.id, idempotencyKey: 'fixture-refund' })
    await createSession(ctx.db, user.id, { ip: '192.0.2.15' })
    const recovery = await app.inject({ method: 'POST', url: '/api/auth/password/forgot/phone', payload: { mobile: user.mobile } })
    expect(recovery.statusCode).toBe(202)
    const challenge = recovery.json().data
    const changed = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token: challenge.challengeToken, code: challenge.developmentCode, password: 'Changed-fixture-123!' } })
    expect(changed.statusCode).toBe(200)
    const soon = new Date(Date.now() + 3600000)
    await ctx.db.update(subscriptions).set({ billingInterval: 'MONTHLY', currentPeriodEnd: soon, nextInvoiceAt: soon, nextDueAt: soon }).where(eq(subscriptions.id, server.subscriptionId!))
    const pending = await purchase(user.id)
    await ctx.db.update(orders).set({ paidAt: new Date(Date.now() - 16 * 60000) }).where(eq(orders.id, pending.order.id))
    await sweepSmsEvents(ctx.db)
    const due = new Date(Date.now() - 1000)
    await ctx.db.update(subscriptions).set({ billingInterval: 'HOURLY', currentPeriodEnd: due, nextInvoiceAt: due, nextDueAt: due }).where(eq(subscriptions.id, server.subscriptionId!))
    await handleRenewalSweep(ctx)
    const unpaid = await purchase(user.id, false)
    const balance = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, wallet.id) }))!.balanceRial
    await debitWallet(ctx.db, user.id, wallet.id, balance, { type: 'manual_debit' })
    await expect(payOrder(ctx.db, { userId: user.id, orderId: unpaid.order.id, walletId: wallet.id, idempotencyKey: 'rejected-payment' })).rejects.toMatchObject({ code: 'insufficient_funds' })
    await handleRenewalSweep(ctx)
    const operation = (await ctx.db.query.providerOperations.findFirst({ where: t => and(eq(t.referenceId, server.id), eq(t.action, 'power_off')) }))!
    expect((await ctx.db.query.smsOutbox.findMany({ where: t => eq(t.key, 'serverStoppedNoCredit') }))).toHaveLength(0)
    await handleServerAction(ctx, { serverId: server.id, operationId: operation.id, action: 'power_off' })
    await ctx.db.update(subscriptions).set({ status: 'grace', graceUntil: new Date(Date.now() - 1000) }).where(eq(subscriptions.id, server.subscriptionId!))
    await handleRenewalSweep(ctx)
    const rows = await ctx.db.query.smsOutbox.findMany()
    const covered = new Set(rows.map(r => r.key))
    expect([...covered].sort()).toEqual(Object.keys(PARSGREEN_TEMPLATES).sort())
    expect(rows.every(r => r.status === 'pending')).toBe(true)
    await Promise.all([dispatchSms(ctx.db, send, 100), dispatchSms(ctx.db, send, 100)])
    expect(send).toHaveBeenCalledTimes(rows.length)
    await dispatchSms(ctx.db, send, 100)
    expect(send).toHaveBeenCalledTimes(rows.length)
    expect((await ctx.db.query.smsOutbox.findMany()).every(r => r.status === 'accepted')).toBe(true)
    for (const row of rows) console.info(`SMS_MATRIX ${row.key}: committed -> one mocked acceptance; segments=${row.segments}`)
  })
  it('suppresses disabled, delayed-disabled, unapproved and rolled-back events without catch-up or replays', async () => {
    const user = await account(), key: SmsKey = 'ticketCreated'
    await enqueueSms(ctx.db, key, user.id, 'queued-before-disable', { ticketNumber: '1052' })
    const pref = await smsPreference(ctx.db, key)
    await ctx.db.transaction(tx => updateSmsPreference(tx, user.id, key, false, pref.version))
    await enqueueSms(ctx.db, key, user.id, 'created-while-disabled', { ticketNumber: '1053' })
    await dispatchSms(ctx.db, send, 100); expect(send).not.toHaveBeenCalled()
    await ctx.db.transaction(tx => updateSmsPreference(tx, user.id, key, true, pref.version + 1, 'rejected'))
    await enqueueSms(ctx.db, key, user.id, 'rejected-pattern', { ticketNumber: '1054' })
    await dispatchSms(ctx.db, send, 100); expect(send).not.toHaveBeenCalled()
    await expect(ctx.db.transaction(async tx => { await enqueueSms(tx, key, user.id, 'rolled-back', { ticketNumber: '1055' }); throw new Error('rollback') })).rejects.toThrow('rollback')
    expect(await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'rolled-back') })).toBeUndefined()
    await expect(ctx.db.transaction(tx => updateSmsPreference(tx, user.id, key, true, pref.version))).rejects.toMatchObject({ code: 'conflict' })
    await ctx.db.transaction(tx => updateSmsPreference(tx, user.id, key, true, pref.version + 2, 'approved-pattern'))
    await dispatchSms(ctx.db, send, 100); expect(send).not.toHaveBeenCalled()
    const first = await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'created-while-disabled') })
    expect(first!.status).toBe('skipped_disabled')
    expect((await smsPreference(ctx.db, 'ticketClosed')).version).toBe(0)
  })
  it('does not resend unknown or orphaned attempts; rejects changed/unverified recipients and duplicate keys', async () => {
    const user = await account()
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'unknown-send', { ticketNumber: '1052' })
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'unknown-send', { ticketNumber: '1052' })
    const unknown = vi.fn(async () => { throw new ProviderUnknownError() })
    await dispatchSms(ctx.db, unknown); await dispatchSms(ctx.db, unknown)
    expect(unknown).toHaveBeenCalledTimes(1)
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'orphaned', { ticketNumber: '1053' })
    await ctx.db.execute(sql`update sms_outbox set status='sending', attempted_at=now()-interval '10 minutes' where event_id='orphaned'`)
    await dispatchSms(ctx.db, send); expect(send).not.toHaveBeenCalled()
    expect((await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'orphaned') }))!.status).toBe('unknown')
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'changed-phone', { ticketNumber: '1054' })
    await ctx.db.update(users).set({ mobileVerifiedAt: null }).where(eq(users.id, user.id))
    await dispatchSms(ctx.db, send); expect(send).not.toHaveBeenCalled()
    expect((await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'changed-phone') }))!.status).toBe('skipped_recipient')
  })
  it('blocks stale pattern approval on an already queued message', async () => {
    const user = await account()
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'old-approved-revision', { ticketNumber: '1052' })
    await ctx.db.update(smsPreferences).set({ patternHash: 'previous-pattern-revision' }).where(eq(smsPreferences.key, 'ticketCreated'))
    await dispatchSms(ctx.db, send)
    expect(send).not.toHaveBeenCalled()
    expect((await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'old-approved-revision') }))!.status).toBe('blocked_approval_revision')
  })
  it('serializes a completed disable with the provider-send boundary across workers', async () => {
    const user = await account(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'sending-boundary', { ticketNumber: '1052' })
    const sending = vi.fn(async () => { started.resolve(); await release.promise; return {} })
    const dispatch = dispatchSms(ctx.db, sending, 1)
    await started.promise
    const updaterReady = Promise.withResolvers<number>()
    const disabling = ctx.db.transaction(async tx => {
      const result = await tx.execute(sql`select pg_backend_pid() as pid`)
      updaterReady.resolve(Number(result.rows[0]!.pid))
      await updateSmsPreference(tx, user.id, 'ticketCreated', false, 0)
    })
    const pid = await updaterReady.promise
    let waiting = false
    try {
      for (let i = 0; i < 50 && !waiting; i++) {
        const state = await ctx.db.execute(sql`select wait_event_type from pg_stat_activity where pid=${pid}`)
        waiting = state.rows[0]?.wait_event_type === 'Lock'
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
    } finally { release.resolve(); await Promise.all([dispatch, disabling]) }
    await enqueueSms(ctx.db, 'ticketCreated', user.id, 'after-completed-disable', { ticketNumber: '1053' })
    await dispatchSms(ctx.db, sending)
    expect(sending).toHaveBeenCalledTimes(1)
    expect((await ctx.db.query.smsOutbox.findFirst({ where: t => eq(t.eventId, 'after-completed-disable') }))!.status).toBe('skipped_disabled')
  })
  it('enforces admin RBAC, versioned independent switches and enhanced auth-channel confirmation', async () => {
    const user = await account(), admin = await account(true)
    const u = await createSession(ctx.db, user.id, {}), a = await createSession(ctx.db, admin.id, {})
    const url = '/api/admin/settings/sms'
    expect((await app.inject({ url, headers: { authorization: `Bearer ${u.token}` } })).statusCode).toBe(403)
    const headers = { authorization: `Bearer ${a.token}` }
    const result = await app.inject({ url, headers }); expect(result.statusCode).toBe(200)
    expect(result.json().data).toHaveLength(24)
    expect((await app.inject({ method: 'POST', url: url + '/phoneLogin', headers, payload: { enabled: false, version: 0, confirm: true } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: url + '/phoneLogin', headers, payload: { enabled: false, version: 0, confirm: true, password: 'Fixture-password-123!', confirmation: 'تأیید تغییر امنیت پیامک' } })).statusCode).toBe(200)
    expect((await smsPreference(ctx.db, 'phoneVerification')).enabled).toBe(true)
    const denied = await app.inject({ method: 'POST', url: '/api/auth/phone/start', payload: { mobile: user.mobile } })
    expect(denied.statusCode).toBe(503)
    expect(denied.json().error).toBe('sms_channel_disabled')
  })
  it('binds account-operation OTP to the user/session/purpose and commits failed-attempt budgets', async () => {
    const user = await account(), other = await account()
    const session = await createSession(ctx.db, user.id, {}), wrongSession = await createSession(ctx.db, other.id, {})
    const headers = { authorization: `Bearer ${session.token}` }
    const start = await app.inject({ method: 'POST', url: '/api/auth/account/operation/start', headers })
    expect(start.statusCode).toBe(202)
    const challenge = start.json().data
    const payload = { token: challenge.challengeToken, code: challenge.developmentCode, currentPassword: 'Fixture-password-123!', password: 'Updated-fixture-password-123!' }
    expect((await app.inject({ method: 'POST', url: '/api/auth/account/password', headers: { authorization: `Bearer ${wrongSession.token}` }, payload })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload })).statusCode).toBe(400)
    const wrongCode = challenge.developmentCode === '000000' ? '000001' : '000000'
    const failure = await app.inject({ method: 'POST', url: '/api/auth/account/password', headers, payload: { ...payload, code: wrongCode } })
    expect(failure.statusCode).toBe(400)
    expect((await ctx.db.query.authChallenges.findFirst({ where: t => eq(t.userId, user.id) }))!.attempts).toBe(1)
    const changed = await app.inject({ method: 'POST', url: '/api/auth/account/password', headers, payload })
    expect(changed.statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/auth/account/password', headers, payload })).statusCode).toBe(400)
    expect(await ctx.db.query.smsOutbox.findMany({ where: t => eq(t.key, 'passwordChanged') })).toHaveLength(1)
  })
  it('never sends recovery resends to an unknown/unverified account', async () => {
    const before = vi.mocked(delivery.sendParsGreenSms).mock.calls.length
    const start = await app.inject({ method: 'POST', url: '/api/auth/password/forgot/phone', payload: { mobile: '+989222222222' } })
    expect(start.statusCode).toBe(202)
    const row = (await ctx.db.query.authChallenges.findFirst({ where: t => eq(t.identifier, '+989222222222') }))!
    await ctx.db.execute(sql`update auth_challenges set resend_after=now()-interval '1 minute' where id=${row.id}::uuid`)
    expect((await app.inject({ method: 'POST', url: '/api/auth/challenge/resend', payload: { token: start.json().data.challengeToken } })).statusCode).toBe(202)
    expect(vi.mocked(delivery.sendParsGreenSms).mock.calls.length).toBe(before)
  })
})
