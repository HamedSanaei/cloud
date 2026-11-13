import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import * as config from '../../src/config.js'
import { orders, users, systemEvents, settings, adminAuthorizations } from '../../src/db/schema.js'
import { createSession, registerUser, hashPassword, authenticateToken } from '../../src/modules/auth/service.js'
import { createTotpSecret, generateTotpCode as currentTotp, encryptTotpSecret } from '../../src/modules/auth/totp.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { writeAudit } from '../../src/modules/audit/service.js'
import { coordinationPool, exclusive, operationsLock, sharedWriter, writerLock } from '../../src/modules/system/writer-gate.js'
import { requestAdjustment, approveAdjustment } from '../../src/modules/system/finance.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

const password = 'Fixture-system-only-123!', oldMerchant = '11111111-1111-4111-8111-111111111111', nextMerchant = '22222222-2222-4222-8222-222222222222', base = '/api/admin/settings'
describe.skipIf(!dbAvailable)('store system security and real ledger integration', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>, app: FastifyInstance, c: ReturnType<typeof config.getConfig>, sequence = 0
  const tokens = new Map<string, { amount: string; merchant: string }>()
  beforeAll(async () => {
    ctx = await getTestContext(); await truncateAll(ctx.db); await ctx.db.delete(settings).where(eq(settings.key, 'tabapay.active'))
    c = { ...config.getConfig(), DATA_AUTHORITY: 'site', STORE_SECRET_KEY: 'a'.repeat(64), SYSTEM_BACKUP_ENABLED: false, SYSTEM_RESTORE_ENABLED: false,
      SYSTEM_ADMIN_IDS: '', SYSTEM_BACKUP_DIR: path.join(tmpdir(), 'codex-system-integration-' + randomUUID()), TABAPAY_ENABLED: true, TABAPAY_MERCHANT: oldMerchant, TABAPAY_SANDBOX: true, SYSTEM_DUAL_APPROVAL_RIAL: 1000000 }
    vi.spyOn(config, 'getConfig').mockImplementation(() => c)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200 })
      expect(url).toMatch(/^https:\/\/api\.tabapay\.ir\/v1\/sandbox\/(create|verify)$/)
      const form = init.body as FormData, merchant = (init.headers as Record<string, string>).Authorization!.slice(7)
      if (url.endsWith('/create')) { const token = randomUUID(); tokens.set(token, { amount: String(form.get('amount')), merchant }); return new Response(JSON.stringify({ responseCode: 1, status: 'success', token, url: `https://api.tabapay.ir/sandbox/pay/${token}` })) }
      const token = String(form.get('token')), original = tokens.get(token)!
      expect(merchant).toBe(original.merchant); expect(form.get('amount')).toBe(original.amount)
      return new Response(JSON.stringify({ responseCode: 2, status: 'success', token, amount: Number(original.amount), shaparakRefNumber: BigInt('0x' + token.replaceAll('-', '')).toString() }))
    }))
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger }); await app.ready()
  })
  afterAll(async () => { await app?.close(); await ctx?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  async function account(role: 'user' | 'admin' = 'admin', allowed = true) {
    const n = ++sequence, user = await registerUser(ctx.db, { email: `sys-${n}@fixture.test`, password, mobile: '+98912' + String(n).padStart(7, '0') })
    const secret = createTotpSecret()
    await ctx.db.update(users).set({ role, twoFactorEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) }).where(eq(users.id, user.id))
    if (role === 'admin' && allowed) c.SYSTEM_ADMIN_IDS += (c.SYSTEM_ADMIN_IDS ? ',' : '') + user.id
    const session = await createSession(ctx.db, user.id, {}), wallet = await ensureDefaultWallet(ctx.db, user.id)
    return { user, wallet, secret, session, remoteAddress: `192.0.2.${n}`, headers: { authorization: `Bearer ${session.token}` } }
  }
  type Account = Awaited<ReturnType<typeof account>>
  async function send(a: Account, method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) {
    return app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), remoteAddress: a.remoteAddress, headers: { 'content-type': 'application/json', ...a.headers, ...headers } })
  }
  async function proof(a: Account, action: string, payload: unknown) {
    const response = await send(a, 'POST', base + '/authorize', { action, payload, password, code: currentTotp(a.secret) })
    expect(response.statusCode, response.body).toBe(200); return response.json().data.proof as string
  }
  it('denies users, non-allowlisted admins, missing MFA and unauthorized uploads before parsing', async () => {
    const user = await account('user'), other = await account('admin', false), admin = await account()
    expect((await app.inject(base + '/logs')).statusCode).toBe(401)
    expect((await send(user, 'GET', base + '/logs')).statusCode).toBe(403)
    expect((await send(other, 'GET', base + '/gateway')).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: base + '/backups/upload', payload: Buffer.from('not a dump'), headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(401)
    await ctx.db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, admin.user.id))
    expect((await send(admin, 'POST', base + '/authorize', { action: 'gateway.diagnose', payload: { confirm: true }, password, code: currentTotp(admin.secret) })).statusCode).toBe(403)
  })
  it('binds step-up to exact payload, action, session and a single use', async () => {
    const a = await account(), payload = { enabled: true, sandbox: true, merchant: nextMerchant, confirm: true }, grant = await proof(a, 'gateway.update', payload)
    expect((await send(a, 'POST', base + '/gateway', { ...payload, enabled: false, proof: grant })).statusCode).toBe(403)
    const session = await createSession(ctx.db, a.user.id, {})
    expect((await send(a, 'POST', base + '/gateway', { ...payload, proof: grant }, { authorization: `Bearer ${session.token}` })).statusCode).toBe(403)
    expect((await send(a, 'POST', base + '/gateway', { ...payload, proof: grant })).statusCode).toBe(200)
    expect((await send(a, 'POST', base + '/gateway', { ...payload, proof: grant })).statusCode).toBe(403)
    await ctx.db.delete(settings).where(eq(settings.key, 'tabapay.active'))
  })
  it('bootstraps management MFA with a password and does not allow replacing or disabling an enabled key without its code', async () => {
    const a = await account()
    await ctx.db.update(users).set({ twoFactorEnabled: false, totpSecretEncrypted: null }).where(eq(users.id, a.user.id))
    expect((await send(a, 'POST', base + '/mfa/setup', { password: 'wrong' })).statusCode).toBe(403)
    const setup = await send(a, 'POST', base + '/mfa/setup', { password })
    expect(setup.statusCode).toBe(200); expect(setup.json().data.recoveryCodes).toHaveLength(8)
    const secret = setup.json().data.secret
    expect((await send(a, 'GET', base + '/capabilities')).body).not.toContain(secret)
    expect((await send(a, 'POST', base + '/mfa/enable', { password, code: currentTotp(secret) })).statusCode).toBe(200)
    expect((await send(a, 'POST', base + '/mfa/setup', { password })).statusCode).toBe(403)
    expect((await send(a, 'POST', '/api/auth/2fa/disable', { password })).statusCode).toBe(403)
  })
  it('rejects expired grants and invalidates previously issued grants after password changes', async () => {
    const a = await account(), payload = { confirm: true }, expired = await proof(a, 'gateway.diagnose', payload)
    await ctx.db.update(adminAuthorizations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(adminAuthorizations.id, expired))
    expect((await send(a, 'POST', base + '/gateway/diagnose', { ...payload, proof: expired })).statusCode).toBe(403)
    const old = await proof(a, 'gateway.diagnose', payload)
    await ctx.db.update(users).set({ passwordHash: await hashPassword('Changed-fixture-only-123!') }).where(eq(users.id, a.user.id))
    expect((await send(a, 'POST', base + '/gateway/diagnose', { ...payload, proof: old })).statusCode).toBe(403)
  })
  it('retains encrypted old credentials for pending verify/callback through rotation, disable and rollback', async () => {
    const a = await account(), customer = await account('user')
    const create = () => send(customer, 'POST', '/api/wallets/recharges', { walletId: customer.wallet.id, amountToman: 10000 }, { 'idempotency-key': randomUUID() })
    const first = (await create()).json().data, second = (await create()).json().data
    const payload = { enabled: false, sandbox: true, merchant: nextMerchant, confirm: true }
    expect((await send(a, 'POST', base + '/gateway', { ...payload, proof: await proof(a, 'gateway.update', payload) })).statusCode).toBe(200)
    const encrypted = await ctx.db.query.gatewayCredentials.findMany()
    expect(encrypted.every(v => !v.encrypted.includes(oldMerchant) && !v.encrypted.includes(nextMerchant))).toBe(true)
    const status = await send(a, 'GET', base + '/gateway')
    expect(status.body).not.toContain(nextMerchant); expect(status.json().data.maskedMerchant).toBe('••••2222')
    expect((await send(customer, 'POST', `/api/wallets/recharges/${first.id}/verify`, {})).json().data.status).toBe('succeeded')
    const signature = createHash('md5').update(oldMerchant).digest('hex')
    const callback = () => app.inject({ method: 'POST', url: '/api/v1/payments/tabapay/callback', headers: { authorize: signature }, payload: { token: second.paymentUrl.split('/').pop() } })
    expect((await callback()).json()).toEqual({ status: 'success' }); await callback()
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, customer.wallet.id) }))!.balanceRial).toBe(200000)
    const rollback = { enabled: true, sandbox: true, version: createHash('sha256').update(oldMerchant).digest('hex'), confirm: true }
    expect((await send(a, 'POST', base + '/gateway', { ...rollback, proof: await proof(a, 'gateway.update', rollback) })).statusCode).toBe(200)
    const before = vi.mocked(fetch).mock.calls.length
    const diagnostic = await send(a, 'POST', base + '/gateway/diagnose', { confirm: true, proof: await proof(a, 'gateway.diagnose', { confirm: true }) })
    expect(diagnostic.json().data.domain).toBe('provider_confirmation_required')
    expect(vi.mocked(fetch).mock.calls.slice(before).every(([, init]) => init?.method === 'HEAD')).toBe(true)
  })
  it('finds exact normalized mobile/email and serializes equal financial retries without bypass through legacy URLs', async () => {
    const a = await account(), customer = await account('user'), other = await account('user')
    const mobile = ('0' + customer.user.mobile!.slice(3)).replace(/\d/g, v => '۰۱۲۳۴۵۶۷۸۹'[Number(v)]!)
    expect((await send(a, 'GET', base + '/finance/users?' + new URLSearchParams({ search: mobile }))).json().data[0].id).toBe(customer.user.id)
    expect((await send(a, 'GET', base + '/finance/users?' + new URLSearchParams({ search: customer.user.email.toUpperCase() }))).json().data).toHaveLength(1)
    const payload = { userId: customer.user.id, walletId: customer.wallet.id, direction: 'credit', amountRial: 500000, reason: 'Fixture financial correction', reference: 'FIXTURE-9', confirm: true }, key = randomUUID(), grant = await proof(a, 'wallet.adjust', payload)
    const response = () => send(a, 'POST', base + '/finance/adjustments', { ...payload, proof: grant }, { 'idempotency-key': key })
    const results = await Promise.all([response(), response()])
    expect(results.every(r => r.statusCode === 200)).toBe(true); expect(results[0]!.json().data.id).toBe(results[1]!.json().data.id)
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, customer.wallet.id) }))!.balanceRial).toBe(500000)
    expect((await send(a, 'POST', base + '/finance/adjustments', { ...payload, amountRial: 500001, proof: grant }, { 'idempotency-key': key })).statusCode).toBe(409)
    const foreign = { ...payload, walletId: other.wallet.id }
    expect((await send(a, 'POST', base + '/finance/adjustments', { ...foreign, proof: await proof(a, 'wallet.adjust', foreign) }, { 'idempotency-key': randomUUID() })).statusCode).toBe(404)
    expect((await send(a, 'POST', `/api/admin/wallets/${customer.wallet.id}/credit`, { amountRial: 1000, note: 'old bypass' })).statusCode).toBe(422)
  })
  it('blocks financial service mutations after an authority cutover even with previously valid grants', async () => {
    const a = await account(), b = await account(), customer = await account('user')
    const input = { userId: customer.user.id, walletId: customer.wallet.id, direction: 'credit' as const, amountRial: 1000000, reason: 'Fixture authority correction', reference: 'FIXTURE-AUTHORITY', confirm: true as const }
    const grant = await proof(a, 'wallet.adjust', input)
    const pending = await requestAdjustment(ctx.db, (await authenticateToken(ctx.db, a.session.token))!, input, randomUUID(), grant)
    const freshGrant = await proof(a, 'wallet.adjust', input), approval = await proof(b, 'wallet.approve', { id: pending.id, confirm: true })
    const actor = (await authenticateToken(ctx.db, a.session.token))!, approver = (await authenticateToken(ctx.db, b.session.token))!
    c.DATA_AUTHORITY = 'platform'
    try {
      await expect(requestAdjustment(ctx.db, actor, input, randomUUID(), freshGrant)).rejects.toMatchObject({ status: 403 })
      await expect(approveAdjustment(ctx.db, approver, pending.id, approval)).rejects.toMatchObject({ status: 403 })
      expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, customer.wallet.id) }))!.balanceRial).toBe(0)
      expect((await ctx.db.query.adminAdjustments.findFirst({ where: t => eq(t.id, pending.id) }))!.status).toBe('awaiting_approval')
    } finally { c.DATA_AUTHORITY = 'site' }
  })
  it('requires a distinct authorized second admin for a large credit', async () => {
    const a = await account(), b = await account(), customer = await account('user')
    const payload = { userId: customer.user.id, walletId: customer.wallet.id, direction: 'credit', amountRial: 1000000, reason: 'Fixture large correction', reference: 'FIXTURE-LARGE', confirm: true }
    const pending = (await send(a, 'POST', base + '/finance/adjustments', { ...payload, proof: await proof(a, 'wallet.adjust', payload) }, { 'idempotency-key': randomUUID() })).json().data
    expect(pending.status).toBe('awaiting_approval')
    const approvePayload = { id: pending.id, confirm: true }
    expect((await send(a, 'POST', `${base}/finance/adjustments/${pending.id}/approve`, { confirm: true, proof: await proof(a, 'wallet.approve', approvePayload) })).statusCode).toBe(403)
    expect((await send(b, 'POST', `${base}/finance/adjustments/${pending.id}/approve`, { confirm: true, proof: await proof(b, 'wallet.approve', approvePayload) })).json().data.afterRial).toBe(1000000)
  })
  it('protects existing seven-day commitments and serializes distinct concurrent debits', async () => {
    const a = await account(), customer = await account('user')
    await creditWallet(ctx.db, customer.user.id, customer.wallet.id, 500000, { idempotencyKey: randomUUID() })
    await ctx.db.insert(orders).values({ userId: customer.user.id, walletId: customer.wallet.id, orderNumber: randomUUID(), provider: 'hetzner', providerProductId: 'fixture', providerLocation: 'nbg1', hostname: 'fixture', operatingSystem: 'ubuntu', totalRial: 1000, billingInterval: 'HOURLY', status: 'queued' })
    const input = { userId: customer.user.id, walletId: customer.wallet.id, direction: 'debit', amountRial: 400000, reason: 'Fixture debit correction', reference: 'FIXTURE-DEBIT', confirm: true }
    expect((await send(a, 'POST', base + '/finance/adjustments', { ...input, proof: await proof(a, 'wallet.adjust', input) }, { 'idempotency-key': randomUUID() })).statusCode).toBe(422)
    const allowed = { ...input, amountRial: 200000 }, one = await proof(a, 'wallet.adjust', allowed), two = await proof(a, 'wallet.adjust', allowed)
    const responses = await Promise.all([one, two].map(proof => send(a, 'POST', base + '/finance/adjustments', { ...allowed, proof }, { 'idempotency-key': randomUUID() })))
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 422])
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, customer.wallet.id) }))!.balanceRial).toBe(300000)
  })
  it('filters and exports sanitized audit/event records without raw secrets or customer data', async () => {
    const a = await account()
    await writeAudit(ctx.db, { actorId: a.user.id, action: 'fixture.sensitive', metadata: { password: 'DO_NOT_EXPOSE', token: 'DO_NOT_EXPOSE', merchant: oldMerchant, email: 'private@example.test', amountRial: 1234, result: 'failed' } })
    await ctx.db.insert(systemEvents).values({ level: 'error', service: 'api', event: 'fixture.error', requestId: 'fixture-request-9', metadata: { cookie: 'DO_NOT_EXPOSE', httpStatus: 502 } })
    const filters = { page: 1, limit: 20, service: 'audit', level: '', event: 'fixture.sensitive', actorId: a.user.id, search: '' }
    const response = await send(a, 'GET', base + '/logs?' + new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)])))
    expect(response.json().data.items).toHaveLength(1); expect(response.body).not.toMatch(/DO_NOT_EXPOSE|private@example|11111111-1111/)
    const exported = await send(a, 'POST', base + '/logs/export', { ...filters, proof: await proof(a, 'logs.export', filters) })
    expect(exported.statusCode).toBe(200); expect(exported.headers['content-disposition']).toContain('attachment'); expect(exported.body).not.toContain('DO_NOT_EXPOSE')
  })
  it('excludes writers, restore and deployment locks mutually and releases pinned sessions', async () => {
    const pool = coordinationPool(3), client = await pool.connect(), other = await pool.connect()
    try {
      await exclusive(client, writerLock)
      await expect(sharedWriter(pool)).rejects.toMatchObject({ code: 'maintenance' })
      await exclusive(client, operationsLock)
      await expect(exclusive(other, operationsLock)).rejects.toMatchObject({ code: 'system_busy' })
    } finally { client.release(true); other.release(true); await pool.end() }
  })
})
