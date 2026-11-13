import { randomUUID, createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../../src/app.js'
import * as config from '../../src/config.js'
import { orders, servers, users } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

const merchant = '11111111-1111-4111-8111-111111111111' // Synthetic, never sent to a real gateway.
describe.skipIf(!dbAvailable)('site wallet gateway and ticket ownership integration', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>, app: FastifyInstance, sequence = 0
  let creates = 0, mismatch = false, timeout = false
  let referenceOverride: string | undefined
  const invoices = new Map<string, string>()
  beforeAll(async () => {
    ctx = await getTestContext(); await truncateAll(ctx.db)
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.getConfig(), DATA_AUTHORITY: 'site', TABAPAY_ENABLED: true,
      TABAPAY_MERCHANT: merchant, TABAPAY_SANDBOX: true, FRONTEND_URL: 'https://example.test' })
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger }); await app.ready()
  })
  beforeEach(() => {
    creates = 0; mismatch = false; timeout = false
    referenceOverride = undefined
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/api\.tabapay\.ir\/v1\/sandbox\/(create|verify)$/)
      expect(init.redirect).toBe('error')
      const form = init.body as FormData
      if (url.endsWith('/create')) {
        creates++
        if (timeout) throw new Error('simulated ambiguous create')
        const token = randomUUID(); invoices.set(token, String(form.get('amount')))
        return new Response(JSON.stringify({ responseCode: 1, status: 'success', token, url: `https://api.tabapay.ir/sandbox/pay/${token}` }))
      }
      const token = String(form.get('token')), amount = invoices.get(token)
      expect(form.get('amount')).toBe(amount)
      return new Response(JSON.stringify({ responseCode: '2', status: 'success', token,
        amount: Number(amount) + (mismatch ? 10 : 0), shaparakRefNumber: referenceOverride ?? BigInt('0x' + token.replaceAll('-', '')).toString() }))
    }))
  })
  afterAll(async () => { await app?.close(); await ctx?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  async function account(admin = false) {
    const user = await registerUser(ctx.db, { email: `wallet-ticket-${++sequence}@test.local`, password: 'Fixture-only-123!' })
    if (admin) await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id))
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    return { user, wallet, remoteAddress: `192.0.2.${sequence}`, headers: { authorization: `Bearer ${(await createSession(ctx.db, user.id, {})).token}` } }
  }
  async function intent(a: Awaited<ReturnType<typeof account>>, key = randomUUID()) {
    const response = await app.inject({ method: 'POST', url: '/api/wallets/recharges', remoteAddress: a.remoteAddress, headers: { ...a.headers, 'idempotency-key': key }, payload: { walletId: a.wallet.id, amountToman: 20000 } })
    expect(response.statusCode).toBe(200)
    return response.json().data as { id: string; status: string; paymentUrl: string | null }
  }
  async function balance(walletId: string) { return (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, walletId) }))!.balanceRial }

  it('persists a single intent on concurrent retry and never credits on creation', async () => {
    const a = await account(), key = randomUUID()
    const [first, second] = await Promise.all([intent(a, key), intent(a, key)])
    expect(first.id).toBe(second.id); expect(creates).toBe(1); expect(await balance(a.wallet.id)).toBe(0)
    expect((await intent(a, key)).paymentUrl).toMatch(/^https:\/\/api\.tabapay\.ir\/sandbox\/pay\//)
  })
  it('credits exactly the frozen Rial gross amount once across concurrent verifies and callback replay', async () => {
    const a = await account(), payment = await intent(a)
    const verify = () => app.inject({ method: 'POST', url: `/api/wallets/recharges/${payment.id}/verify`, headers: a.headers, payload: {} })
    expect((await Promise.all([verify(), verify()])).every(r => r.statusCode === 200)).toBe(true)
    const token = payment.paymentUrl!.split('/').pop()!
    const callback = await app.inject(`/api/v1/payments/tabapay/callback?token=${token}&amount=1&status=error`)
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe(`https://example.test/wallet?payment=${payment.id}`)
    expect(await balance(a.wallet.id)).toBe(200000)
    const ledger = await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.referenceId, payment.id) })
    expect(ledger).toHaveLength(1); expect(ledger[0]!.amountRial).toBe(200000)
    const notices = await app.inject({ url: '/api/notifications', headers: a.headers })
    expect(notices.json().data).toEqual([expect.objectContaining({ title: 'کیف پول شارژ شد', href: '/wallet' })])
  })
  it('rejects foreign wallets, foreign receipt reads and forged webhooks', async () => {
    const a = await account(), b = await account(), payment = await intent(a)
    expect((await app.inject({ method: 'POST', url: '/api/wallets/recharges', headers: { ...b.headers, 'idempotency-key': randomUUID() }, payload: { walletId: a.wallet.id, amountToman: 20000 } })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/wallets/recharges/${payment.id}`, headers: b.headers })).statusCode).toBe(404)
    const token = payment.paymentUrl!.split('/').pop()!
    expect((await app.inject({ method: 'POST', url: '/api/v1/payments/tabapay/callback', payload: { token, amount: 200000 } })).statusCode).toBe(403)
    expect(await balance(a.wallet.id)).toBe(0)
    const response = await app.inject({ method: 'POST', url: '/api/v1/payments/tabapay/callback', headers: { authorize: createHash('md5').update(merchant).digest('hex') }, payload: { token } })
    expect(response.json()).toEqual({ status: 'success' }); expect(await balance(a.wallet.id)).toBe(200000)
  })
  it('never credits a provider amount mismatch', async () => {
    const a = await account(), payment = await intent(a); mismatch = true
    const response = await app.inject({ method: 'POST', url: `/api/wallets/recharges/${payment.id}/verify`, headers: a.headers, payload: {} })
    expect(response.json().data.status).toBe('pending'); expect(await balance(a.wallet.id)).toBe(0)
  })
  it('rolls back the entire credit when the issuer reference was already used by a different payment', async () => {
    const a = await account(), first = await intent(a), second = await intent(a)
    referenceOverride = '987654321'
    const verify = (id: string) => app.inject({ method: 'POST', url: `/api/wallets/recharges/${id}/verify`, headers: a.headers, payload: {} })
    expect((await verify(first.id)).statusCode).toBe(200)
    expect((await verify(second.id)).statusCode).toBe(500)
    expect(await balance(a.wallet.id)).toBe(200000)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.referenceId, second.id) })).toHaveLength(0)
    expect((await ctx.db.query.walletPayments.findFirst({ where: t => eq(t.id, second.id) }))!.status).toBe('pending')
  })
  it('rejects changed retry payloads and gateway bounds before another issuer create', async () => {
    const a = await account(), key = randomUUID(); await intent(a, key)
    const create = (amountToman: number, idempotencyKey = randomUUID()) => app.inject({ method: 'POST', url: '/api/wallets/recharges', remoteAddress: a.remoteAddress, headers: { ...a.headers, 'idempotency-key': idempotencyKey }, payload: { walletId: a.wallet.id, amountToman } })
    expect((await create(30000, key)).statusCode).toBe(409)
    expect((await create(9999)).statusCode).toBe(422)
    expect((await create(50000001)).statusCode).toBe(422)
    expect(creates).toBe(1); expect(await balance(a.wallet.id)).toBe(0)
  })
  it('does not recreate an ambiguous gateway request with the same key', async () => {
    const a = await account(), key = randomUUID(); timeout = true
    expect((await intent(a, key)).status).toBe('unknown')
    expect((await intent(a, key)).status).toBe('unknown')
    expect(creates).toBe(1); expect(await balance(a.wallet.id)).toBe(0)
  })
  async function serverFor(a: Awaited<ReturnType<typeof account>>) {
    const details = { userId: a.user.id, provider: 'hetzner', providerProductId: 'fixture', providerLocation: 'nbg1', hostname: 'support-fixture', operatingSystem: 'ubuntu' }
    const [order] = await ctx.db.insert(orders).values({ ...details, orderNumber: randomUUID(), totalRial: 1000 }).returning()
    return (await ctx.db.insert(servers).values({ ...details, orderId: order!.id, status: 'active', vcpu: 2, memoryMb: 2048, diskGb: 20, ipv4: '192.0.2.10' }).returning())[0]!
  }
  it('lists only owned servers, accepts general tickets, rejects foreign references and exposes the saved relation to owner/admin', async () => {
    const a = await account(), b = await account(), admin = await account(true), server = await serverFor(a)
    const list = await app.inject({ url: '/api/tickets/servers', headers: a.headers })
    expect(list.json().data.map((s: { id: string }) => s.id)).toEqual([server.id])
    expect((await app.inject({ url: '/api/tickets/servers', headers: b.headers })).json().data).toEqual([])
    const ticket = { title: 'مشکل شبکه سرور', department: 'technical', description: 'شرح درخواست', serverId: server.id }
    expect((await app.inject({ method: 'POST', url: '/api/tickets', headers: b.headers, payload: ticket })).statusCode).toBe(404)
    const created = await app.inject({ method: 'POST', url: '/api/tickets', headers: a.headers, payload: ticket })
    expect(created.json().data.relatedServer).toMatchObject({ id: server.id, name: server.hostname, ip: server.ipv4 })
    const id = created.json().data.id
    const notices = await app.inject({ url: '/api/notifications', headers: a.headers })
    expect(notices.json().data).toEqual([expect.objectContaining({ title: 'تیکت ثبت شد', href: `/tickets?ticket=${id}` })])
    expect((await app.inject({ url: `/api/tickets/${id}`, headers: b.headers })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/admin/console/tickets', headers: b.headers })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/admin/console/tickets', headers: admin.headers })).json().data.items[0].relatedServer.id).toBe(server.id)
    expect((await app.inject({ method: 'POST', url: '/api/tickets', headers: b.headers, payload: { ...ticket, serverId: null } })).statusCode).toBe(200)
    await ctx.db.delete(servers).where(eq(servers.id, server.id)) // Disposable fixture only, no provider call.
    const historical = (await app.inject({ url: `/api/tickets/${id}`, headers: a.headers })).json().data
    expect(historical.serverId).toBeNull(); expect(historical.relatedServer.name).toBe(server.hostname)
    expect((await app.inject({ method: 'POST', url: '/api/tickets', headers: a.headers, payload: ticket })).statusCode).toBe(404)
  })
})
