import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import * as configuration from '../../src/config.js'
import { authChallenges, providerProducts, providers, settings, users } from '../../src/db/schema.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { assertCreationFunding, minimumCreationBalanceRial } from '../../src/modules/billing/creation-funding.js'
import { enableAllOffersForSale, findOfferByProductAndLocation, syncProviderCatalog } from '../../src/modules/catalog/service.js'
import { createOrderFromQuote, payOrder } from '../../src/modules/orders/service.js'
import { handleProvision } from '../../src/modules/provisioning/handlers.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { getProvider, registerProvider, registerConfiguredProviders } from '../../src/modules/providers/registry.js'
import { createHetznerProvider } from '../../src/modules/providers/hetzner/live.js'
import { euroMarketSource, setFxRate, updatePricingRules } from '../../src/modules/pricing/service.js'
import { hetznerPrepaidMonth } from '../../src/modules/pricing/periods.js'
import { creditWallet, ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'
import { operationEmailHeaders } from '../operation-email-fixture.js'
import { ProviderUnknownError } from '../../src/lib/errors.js'
import { readOrderFinancialEvidence } from '../../src/modules/admin/overview.js'

describe.skipIf(!dbAvailable)('checkout funding, datacenter sales and Issue #3', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let app: FastifyInstance
  let offer: NonNullable<Awaited<ReturnType<typeof findOfferByProductAndLocation>>>
  let sequence = 0
  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    const original = getProvider('leaseweb')
    registerProvider({ ...original, id: 'hetzner', name: 'Hetzner', async syncCatalog() {
      const catalog = await original.syncCatalog()
      return { ...catalog, offers: catalog.offers.map(o => ({ ...o, provider: 'hetzner', category: 'cloud' as const,
        billingOptions: [{ billingCycle: 'hourly', amountCents: 10 }] })) }
    } })
    await setFxRate(ctx.db, '620000', { source: 'market', note: euroMarketSource })
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner'))
    await enableAllOffersForSale(ctx.db, 'hetzner')
    offer = (await findOfferByProductAndLocation(ctx.db, 'hetzner', 'VPS02_4', 'FRA-01'))!
    const base = configuration.getConfig()
    vi.spyOn(configuration, 'getConfig').mockReturnValue({ ...base, DATA_AUTHORITY: 'site',
      PROVIDERS: { ...base.PROVIDERS, hetzner: { ...base.PROVIDERS.hetzner, enabled: true, orderingEnabled: true } } })
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })
  afterAll(async () => {
    await app?.close()
    if (ctx) { await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner')); await ctx.close() }
    vi.restoreAllMocks(); registerConfiguredProviders()
  })
  async function account(admin = false) {
    const user = await registerUser(ctx.db, { email: `checkout-${++sequence}@test.local`, password: 'Safe-fixture-pass-123!' })
    if (admin) await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id))
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    const token = (await createSession(ctx.db, user.id, {})).token
    return { user, wallet, headers: { authorization: `Bearer ${token}` } }
  }
  const quoteFor = (userId: string) => createQuote(ctx.db, { userId, offerId: offer.id, locationCode: 'FRA-01', billingOption: { billingCycle: 'hourly' }, billingPeriod: 'hourly', operatingSystem: 'ubuntu-24.04' })
  const body = (walletId: string) => ({ name: 'checkout-server', walletId, offerId: offer.id, os: 'ubuntu-24.04', billingPeriod: 'hourly' })

  it('requires a verified account and a single valid code bound to the exact checkout and session', async () => {
    const a = await account(), quote = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, minimumCreationBalanceRial(quote.totalRial, 'HOURLY'), { type: 'manual_credit' })
    const key = 'email-checkout', payload = { ...body(a.wallet.id), expectedTotalRial: quote.totalRial }
    const intent = { action: 'create' as const, key, payload }
    const invoke = (headers: Record<string, string>, data = payload) => app.inject({ method: 'POST', url: '/api/v1/servers', headers, payload: data })
    const start = () => app.inject({ method: 'POST', url: '/api/auth/operation-email/start', headers: a.headers, payload: intent })
    expect((await invoke({ ...a.headers, 'idempotency-key': key })).json().error).toBe('operation_email_required')
    expect((await start()).json().error).toBe('verified_email_required')
    const email = await app.inject({ method: 'POST', url: '/api/auth/account-email/start', headers: a.headers, payload: { email: a.user.email } })
    expect(email.statusCode).toBe(202)
    const { token, developmentCode: code } = email.json().data
    expect((await app.inject({ method: 'POST', url: '/api/auth/account-email/verify', headers: a.headers, payload: { token, code } })).statusCode).toBe(200)

    const config = configuration.getConfig()
    vi.mocked(configuration.getConfig).mockReturnValue({ ...config, AUTH_DELIVERY_MODE: 'live', SMTP_HOST: '' })
    try { expect((await start()).statusCode).toBeGreaterThanOrEqual(500) }
    finally { vi.mocked(configuration.getConfig).mockReturnValue(config) }

    const issue = () => operationEmailHeaders(app, ctx.db, a.user.id, a.headers, intent)
    const first = await issue()
    expect((await start()).statusCode).toBe(429)
    const anotherSession = await createSession(ctx.db, a.user.id, {})
    expect((await invoke({ ...first, authorization: `Bearer ${anotherSession.token}` })).statusCode).toBe(403)
    expect((await invoke(first, { ...payload, name: 'changed-hostname' })).statusCode).toBe(403)
    const wrong = first['x-operation-code'] === '000000' ? '000001' : '000000'
    expect((await invoke({ ...first, 'x-operation-code': wrong })).json().details.attemptsRemaining).toBe(config.AUTH_OTP_MAX_ATTEMPTS - 1)
    const replacement = await issue()
    expect((await invoke(first)).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/auth/operation-email/cancel', headers: a.headers, payload: { token: replacement['x-operation-token'] } })).json().data.cancelled).toBe(true)
    expect((await invoke(replacement)).statusCode).toBe(400)

    const expired = await issue()
    await ctx.db.update(authChallenges).set({ expiresAt: new Date(0) }).where(and(eq(authChallenges.userId, a.user.id),
      eq(authChallenges.kind, 'server_operation_email'), isNull(authChallenges.consumedAt)))
    expect((await invoke(expired)).statusCode).toBe(410)
    expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)

    const valid = await issue()
    const results = await Promise.all([invoke(valid), invoke(valid)])
    expect(results.map(response => response.statusCode).sort()).toEqual([201, 400])
    const receiptPath = '/api/servers/provisioning/by-request/' + key
    const receipt = await app.inject({ url: receiptPath, headers: a.headers })
    expect(receipt.statusCode).toBe(200)
    expect(receipt.headers['cache-control']).toBe('private, no-store')
    expect(receipt.json().data.tracking.orderId).toBe(results.find(response => response.statusCode === 201)!.json().data.tracking.orderId)
    expect((await app.inject({ url: receiptPath, headers: (await account()).headers })).json().data).toBeNull()
    expect((await app.inject({ url: receiptPath })).statusCode).toBe(401)
    expect((await invoke(valid)).statusCode).toBe(400)
    expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(2)
  })

  it('syncs real-shaped fallback evidence through storage, public HTML and monthly quotes', async () => {
    const included = 2 ** 39
    const location = { name: 'sin', country: 'SG', city: 'Singapore', available: true }
    const responses: Record<string, unknown> = {
      server_types: { server_types: [{ id: 2, name: 'cpx02', architecture: 'x86', cores: 2, memory: 4, disk: 40, locations: [location],
        prices: [{ location: 'sin', price_hourly: { gross: '0.008000' }, included_traffic: included }] }] },
      locations: { locations: [location] },
      images: { images: [{ id: 11, name: 'ubuntu-24.04', type: 'system', status: 'available', architecture: 'x86' }] },
      pricing: { pricing: { currency: 'EUR', server_types: [{ id: 2, name: 'cpx02', prices: [{ location: 'sin',
        price_monthly: { gross: '4.99000000' }, price_per_tb_traffic: { gross: '7.4000000000000000' } }] }],
        primary_ips: [{ type: 'ipv4', prices: [{ location: 'sin', price_hourly: { gross: '0.0008' }, price_monthly: { gross: '0.60' } }] }] } },
    }
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.method).toBe('GET')
      const path = new URL(String(url)).pathname.split('/').at(-1)!
      expect(responses[path]).toBeDefined()
      return Response.json(responses[path])
    }
    const live = createHetznerProvider({ enabled: true, orderingEnabled: true, displayName: 'Hetzner', baseUrl: 'https://fixture.test/v1',
      accounts: [{ id: 'test', label: 'Fixture', priority: 1, enabled: true, state: 'active', apiToken: 'fixture' }] }, { fetch: fetcher })
    try {
      await syncProviderCatalog(ctx.db, live)
      const stored = (await findOfferByProductAndLocation(ctx.db, 'hetzner', 'cpx02:EUR', 'sin'))!
      expect(stored.monthlyEligible).toBe(true)
      expect(stored.billingOptions).toEqual(expect.arrayContaining([expect.objectContaining({ billingCycle: hetznerPrepaidMonth, amount: '5.59' })]))
      await enableAllOffersForSale(ctx.db, 'hetzner')
      const customer = await account()
      const publicOffer = (await app.inject('/api/public/home-prices')).json().data.hetzner.find((row: { id: string }) => row.id === stored.id)
      expect(publicOffer).toMatchObject({ hourly: expect.any(Number), monthly: expect.any(Number), includedTrafficBytes: included,
        trafficOverage: { perTbRial: expect.any(Number), includedBytes: included } })
      expect(JSON.stringify(publicOffer)).not.toMatch(/grossPerTb|monthlyCapGross|fixture/)
      const storefront = (await app.inject('/api/catalog/storefront')).json().data.offers.find((row: { id: string }) => row.id === stored.id)
      expect(storefront.prices).toEqual(expect.arrayContaining([expect.objectContaining({ period: 'monthly', totalRial: publicOffer.monthly })]))
      const quote = await createQuote(ctx.db, { userId: customer.user.id, offerId: stored.id, locationCode: 'sin',
        billingOption: { billingCycle: hetznerPrepaidMonth }, billingPeriod: 'monthly', operatingSystem: '11' })
      expect(quote.totalRial).toBe(publicOffer.monthly)
      for (const scope of ['all', 'hetzner']) {
        const response = await app.inject('/api/public/home-tariffs?scope=' + scope)
        expect(response.body).toContain(`offer=${stored.id}&amp;period=monthly&amp;location=sin`)
        expect(response.body).toContain('<th scope="col">لوکیشن</th>')
        expect(response.body).toContain('<summary aria-label="سنگاپور"><img src="/flags/sg.svg"')
        expect(response.body).toContain('<bdi>Singapore، sin</bdi>')
        expect(response.body).toContain(new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 }).format(publicOffer.monthly / 10) + ' تومان')
        expect(response.body).toContain('۰٫۵۴۹۷۵۵۸۱۳۸۸۸ TB')
        expect(response.body).not.toContain('قیمت ماهانهٔ معتبر در دسترس نیست')
      }
      expect(await ctx.db.query.invoices.findMany({ where: t => eq(t.userId, customer.user.id) })).toEqual([])
      expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.walletId, customer.wallet.id) })).toEqual([])
      await creditWallet(ctx.db, customer.user.id, customer.wallet.id, quote.totalRial, { type: 'manual_credit' })
      const { order } = await createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: quote.id,
        walletId: customer.wallet.id, payFromWallet: true, hostname: 'withdrawn-catalog' })
      const create = vi.spyOn(getProvider('hetzner'), 'createServer').mockImplementation(live.createServer)
      responses.server_types = { server_types: [] }
      try {
        expect((await handleProvision(ctx, { orderId: order.id })).status).toBe('permanent_failure')
        await handleProvision(ctx, { orderId: order.id })
        expect(create).toHaveBeenCalledOnce()
        expect((await app.inject({ url: `/api/servers/provisioning/${order.id}`, headers: customer.headers })).json().data.tracking.failure)
          .toMatchObject({ code: 'capacity_unavailable', billing: 'refunded' })
        const ledger = await ctx.db.query.walletTransactions.findMany({ where: t => and(eq(t.referenceType, 'order'), eq(t.referenceId, order.id)) })
        expect(ledger.map(row => row.amountRial).sort((a, b) => a - b)).toEqual([-quote.totalRial, quote.totalRial])
      } finally { create.mockRestore() }
    } finally { await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' }) }
  })

  it('lets only a superadmin link an already-posted credit to a rejected order without a second credit', async () => {
    const customer = await account(), admin = await account(true), operator = await account(true)
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, operator.user.id))
    const root = '/api/admin/settings'
    const send = (url: string, headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url, headers, payload, remoteAddress: '127.0.0.42' })
    const proof = async (action: string, payload: object) => {
      const response = await send(root + '/authorize', operator.headers, { action, payload })
      expect(response.statusCode).toBe(200)
      return response.json().data.proof as string
    }
    const quote = await quoteFor(customer.user.id)
    await creditWallet(ctx.db, customer.user.id, customer.wallet.id, minimumCreationBalanceRial(quote.totalRial, 'HOURLY'), { type: 'manual_credit' })
    const { order } = await createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: quote.id,
      walletId: customer.wallet.id, payFromWallet: true, hostname: 'rejected-refund-link' })
    const create = vi.spyOn(getProvider('hetzner'), 'createServer').mockRejectedValue(new ProviderUnknownError('fixture missing response'))
    try {
      expect((await handleProvision(ctx, { orderId: order.id })).status).toBe('unknown_scheduled_reconciliation')
    } finally { create.mockRestore() }
    const op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.referenceId, order.id) }))!
    expect((await send(`/api/admin/provider-operations/${op.id}/mark-rejected`, operator.headers, { note: 'Fixture confirmed no server' })).statusCode).toBe(200)
    const adjustment = { userId: customer.user.id, walletId: customer.wallet.id, direction: 'credit', amountRial: order.totalRial,
      reason: 'Credit posted for the rejected order', reference: order.id, confirm: true }
    const adjusted = await send(root + '/finance/adjustments', { ...operator.headers, 'idempotency-key': 'fixture-refund-link' },
      { ...adjustment, proof: await proof('wallet.adjust', adjustment) })
    expect(adjusted.statusCode).toBe(200)
    const link = { orderId: order.id, adjustmentId: adjusted.json().data.id as string, confirm: true }
    const linkPath = root + '/finance/order-refunds/link'
    const track = async () => (await app.inject({ url: `/api/servers/provisioning/${order.id}`, headers: customer.headers })).json().data.tracking
    expect((await track()).failure.billing).toBe('captured')
    expect((await send(root + '/authorize', admin.headers, { action: 'wallet.link-refund', payload: link })).statusCode).toBe(403)
    expect((await send(linkPath, operator.headers, { ...link, proof: crypto.randomUUID() })).statusCode).toBe(403)
    const ledgerBefore = await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, customer.user.id) })
    const linkWithProof = async () => send(linkPath, operator.headers, { ...link, proof: await proof('wallet.link-refund', link) })
    expect((await linkWithProof()).statusCode).toBe(200)
    expect((await linkWithProof()).statusCode).toBe(200)
    expect((await track()).failure.billing).toBe('refunded')
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, customer.user.id) })).toEqual(ledgerBefore)
    expect(await readOrderFinancialEvidence(ctx.db, order.id)).toMatchObject({ debitRial: order.totalRial, refundRial: order.totalRial, unreturned: false, mismatch: false })
    expect((await send(`/api/admin/provider-operations/${op.id}/retry`, operator.headers, {})).statusCode).toBe(409)
  })

  it('limits Hetzner margin to the existing superadmin and persists a versioned change across retail periods', async () => {
    const owner = await account(true), admin = await account(true), customer = await account()
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, owner.user.id))
    const path = '/api/admin/settings/hetzner-margin'
    const oldOptions = offer.billingOptions ?? []
    const monthly = { billingCycle: hetznerPrepaidMonth, amount: '10', amountCents: 1000 }
    try {
      await ctx.db.update(providerProducts).set({ billingOptions: [...oldOptions as object[], monthly] }).where(eq(providerProducts.id, offer.id))
      const current = await app.inject({ url: path, headers: owner.headers })
      expect(current.statusCode, current.body).toBe(200)
      const before = current.json().data
      const input = { markupPercent: '20.1250', markupFixedRial: 123, version: before.version }
      const send = (url: string, payload: object, headers = owner.headers) => app.inject({ method: 'POST', url, headers, payload })
      const payload = { ...input, confirm: true }
      const action = { action: 'pricing.hetzner_margin', payload }
      for (const actor of [admin, customer]) {
        expect((await app.inject({ url: path, headers: actor.headers })).statusCode).toBe(403)
        expect((await send(path + '/preview', input, actor.headers)).statusCode).toBe(403)
        expect((await send('/api/admin/settings/authorize', action, actor.headers)).statusCode).toBe(403)
      }
      const legacy = '/api/admin/pricing?provider=hetzner'
      expect((await app.inject({ url: legacy, headers: admin.headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'PUT', url: '/api/admin/pricing', headers: admin.headers, payload: { provider: 'hetzner', markupPercent: 0 } })).statusCode).toBe(403)
      expect((await send(path + '/preview', { ...input, markupPercent: '1.12345' })).statusCode).toBe(422)
      const oldQuote = await quoteFor(customer.user.id)
      const preview = await send(path + '/preview', input)
      expect(preview.statusCode, preview.body).toBe(200)
      const grant = await send('/api/admin/settings/authorize', action)
      expect(grant.statusCode, grant.body).toBe(200)
      const save = await send(path, { ...payload, proof: grant.json().data.proof })
      expect(save.statusCode, save.body).toBe(200)
      expect((await send(path + '/preview', input)).statusCode).toBe(409)
      const refreshed = (await app.inject({ url: path, headers: owner.headers })).json().data
      expect(refreshed).toMatchObject({ markupPercent: '20.1250', markupFixedRial: 123, updatedBy: owner.user.id })
      expect(refreshed.history[0]).toMatchObject({ actorId: owner.user.id,
        before: { markupPercent: before.markupPercent }, after: { markupPercent: '20.1250', markupFixedRial: 123, updatedAt: refreshed.version } })
      const hourlyQuote = await quoteFor(customer.user.id)
      const monthlyQuote = await createQuote(ctx.db, { userId: customer.user.id, offerId: offer.id, locationCode: 'FRA-01',
        billingOption: monthly, billingPeriod: 'monthly', operatingSystem: 'ubuntu-24.04' })
      const publicOffer = (await app.inject('/api/public/home-prices')).json().data.hetzner.find((row: { id: string }) => row.id === offer.id)
      expect(publicOffer).toMatchObject({ hourly: hourlyQuote.totalRial, monthly: monthlyQuote.totalRial })
      const orderInput = { userId: customer.user.id, quoteId: monthlyQuote.id, hostname: 'prepaid-month', idempotencyKey: 'prepaid-month-review' }
      await expect(createOrderFromQuote(ctx.db, { ...orderInput, expectedTotalRial: monthlyQuote.totalRial - 1 })).rejects.toMatchObject({ code: 'server_price_changed' })
      const accepted = await createOrderFromQuote(ctx.db, { ...orderInput, expectedTotalRial: monthlyQuote.totalRial })
      expect(accepted.order).toMatchObject({ billingInterval: 'MONTHLY', totalRial: publicOffer.monthly, status: 'awaiting_payment' })
      const replay = await createOrderFromQuote(ctx.db, { ...orderInput, expectedTotalRial: monthlyQuote.totalRial + 1 })
      expect(replay.order.id).toBe(accepted.order.id)
      expect(hourlyQuote.totalRial).not.toBe(oldQuote.totalRial)
      const stored = (await app.inject({ url: '/api/quotes/' + oldQuote.id, headers: customer.headers })).json().data
      expect(stored.totalRial).toBe(oldQuote.totalRial)
      expect(stored).not.toHaveProperty('providerAmountCents')
      const catalog = (await app.inject({ url: '/api/catalog/vps/' + offer.id, headers: admin.headers })).json().data
      expect(catalog).not.toHaveProperty('billingOptions')
      expect(catalog).not.toHaveProperty('providerPriceCents')
    } finally {
      await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, owner.user.id))
      await ctx.db.update(providerProducts).set({ billingOptions: oldOptions }).where(eq(providerProducts.id, offer.id))
      await updatePricingRules(ctx.db, 'hetzner', { markupPercent: configuration.getConfig().STOREFRONT_PRICING.hetzner?.markupPercent ?? 25, markupFixedRial: 0 })
    }
  })

  it('publishes only current retail offers and approved independent Iran rates', async () => {
    const admin = await account(true), customer = await account()
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, admin.user.id))
    const read = async () => (await app.inject('/api/public/home-prices')).json().data
    const iran = { rates: { outbound: 123450, inbound: 0, cpu: 250000, ram: null }, trafficUnit: 'TB', tax: 'included', published: false }
    const update = (headers: Record<string, string>, value: unknown) => app.inject({ method: 'POST', url: '/api/admin/settings/iran-tariffs', headers, payload: value as object })
    const original = (await read()).hetzner.find((row: { id: string }) => row.id === offer.id)
    const metadata = (await read()).meta
    expect(metadata.status).toBe('available')
    expect(Date.parse(metadata.validUntil)).toBeGreaterThan(Date.now())
    expect(Date.parse(metadata.validUntil) - Date.parse(metadata.checkedAt)).toBeLessThanOrEqual(60_000)
    expect(original).toMatchObject({ hourly: expect.any(Number), monthly: null })
    expect(original).not.toHaveProperty('operatingSystems')
    expect(original).not.toHaveProperty('canonicalPricing')
    expect((await update(customer.headers, iran)).statusCode).toBe(403)
    expect((await update(admin.headers, iran)).statusCode).toBe(200)
    expect((await read()).iran).toBeNull()
    expect((await update(admin.headers, { ...iran, published: true })).statusCode).toBe(200)
    try {
      expect((await read()).iran).toEqual({ rates: iran.rates, trafficUnit: 'TB', tax: 'included' })
      const html = await app.inject('/api/public/home-tariffs')
      expect(html.headers['cache-control']).toBe('no-store')
      expect(html.body).toContain('۱۲٬۳۴۵ تومان')
      expect(html.body).toContain('هر TB برابر ۱٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ بایت است.')
      expect(html.body).toContain(`offer=${offer.id}&amp;period=hourly`)
      const focused = await app.inject('/api/public/home-tariffs?scope=hetzner')
      expect(focused.body).toContain(`offer=${offer.id}&amp;period=hourly`)
      expect(focused.body).not.toContain('نرخ واحد منابع سرور ایران')
      await setFxRate(ctx.db, '720000', { source: 'market', note: euroMarketSource })
      const repriced = (await read()).hetzner.find((row: { id: string }) => row.id === offer.id)
      expect(repriced.hourly).toBeGreaterThan(original.hourly)
      const rule = await updatePricingRules(ctx.db, 'hetzner', { markupFixedRial: 150000 })
      expect((await read()).hetzner.find((row: { id: string }) => row.id === offer.id).hourly).toBeGreaterThan(repriced.hourly)
      expect(rule.markupFixedRial).toBe(150000)
      await ctx.db.update(providerProducts).set({ lastSyncedAt: new Date(0) }).where(eq(providerProducts.id, offer.id))
      expect((await read()).hetzner.some((row: { id: string }) => row.id === offer.id)).toBe(false)
      await ctx.db.update(providers).set({ enabled: false }).where(eq(providers.id, 'hetzner'))
      const authenticated = await app.inject({ url: '/api/public/home-prices', headers: admin.headers })
      expect(authenticated.json().data.hetzner).toEqual([])
    } finally {
      await setFxRate(ctx.db, '620000', { source: 'market', note: euroMarketSource })
      await updatePricingRules(ctx.db, 'hetzner', { markupFixedRial: 0 })
      await ctx.db.update(providerProducts).set({ lastSyncedAt: offer.lastSyncedAt }).where(eq(providerProducts.id, offer.id))
      await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner'))
      await ctx.db.delete(settings).where(eq(settings.key, 'catalog.iran_monthly_tariffs'))
    }
  })

  it('returns structured shortfall and creates no order, invoice, debit, server or provider operation on insufficient balance', async () => {
    const a = await account()
    const operationsBefore = await ctx.db.query.providerOperations.findMany({ columns: { id: true } })
    const q = await quoteFor(a.user.id)
    const required = minimumCreationBalanceRial(q.totalRial, 'HOURLY')
    await creditWallet(ctx.db, a.user.id, a.wallet.id, required - 1, { type: 'manual_credit' })
    const payload = { ...body(a.wallet.id), expectedTotalRial: q.totalRial }
    const headers = await operationEmailHeaders(app, ctx.db, a.user.id, a.headers, { action: 'create', key: 'underfunded', payload })
    const request = { method: 'POST' as const, url: '/api/servers', headers, payload }
    const response = await app.inject(request)
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'insufficient_funds', message: 'موجودی کیف پول شما کافی نیست.', details: { requiredBalanceRial: required, shortfallRial: 1 } })
    expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.invoices.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.servers.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(0)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
    expect(await ctx.db.query.providerOperations.findMany({ columns: { id: true } })).toEqual(operationsBefore)
    // Same failed command can succeed after funding, without consuming its key.
    await creditWallet(ctx.db, a.user.id, a.wallet.id, 1, { type: 'manual_credit' })
    const success = await app.inject(request)
    expect(success.statusCode).toBe(201)
    const balance = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, a.wallet.id) }))!.balanceRial
    expect(balance).toBe(required - q.totalRial)
  })

  it('serializes simultaneous retries to one order and debit and scopes replay to its owner', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const input = { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'retry-server', idempotencyKey: 'concurrent-retry' }
    const [first, second] = await Promise.all([createOrderFromQuote(ctx.db, input), createOrderFromQuote(ctx.db, input)])
    expect(first.order.id).toBe(second.order.id)
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
    expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.referenceId, first.order.id) })).toHaveLength(1)
    const b = await account()
    await expect(createOrderFromQuote(ctx.db, { ...input, userId: b.user.id, walletId: b.wallet.id })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recovers a failed queue enqueue by replaying the paid order without charging again', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const enqueue = vi.spyOn(ctx.queues, 'addProvision').mockRejectedValueOnce(new Error('fixture queue unavailable'))
    try {
      const payload = { ...body(a.wallet.id), expectedTotalRial: q.totalRial }
      const verified = () => operationEmailHeaders(app, ctx.db, a.user.id, a.headers, { action: 'create', key: 'queue-recovery', payload })
      const request = { method: 'POST' as const, url: '/api/servers', headers: await verified(), payload }
      expect((await app.inject(request)).statusCode).toBe(500)
      expect((await app.inject(request)).statusCode).toBe(400)
      const replay = await app.inject({ ...request, headers: await verified() })
      expect(replay.statusCode).toBe(200)
      expect(enqueue).toHaveBeenCalledTimes(2)
      expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1])
      expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
      const transactions = await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, a.user.id) })
      expect(transactions.filter(t => t.type === 'purchase')).toHaveLength(1)
    } finally { enqueue.mockRestore() }
  })

  it('does not reuse one week of funds for two simultaneous distinct orders', async () => {
    const a = await account()
    const [q1, q2] = await Promise.all([quoteFor(a.user.id), quoteFor(a.user.id)])
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q1.totalRial * 168, { type: 'manual_credit' })
    const results = await Promise.allSettled([q1, q2].map(q => createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'quota-safe' })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'insufficient_funds' } })
  })

  it('applies the funding rule to deferred payments and binds their actual payment wallet', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    const unpaid = await createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, hostname: 'deferred-payment' })
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168 - 1, { type: 'manual_credit' })
    const payment = { userId: a.user.id, walletId: a.wallet.id, orderId: unpaid.order.id }
    await expect(payOrder(ctx.db, payment)).rejects.toMatchObject({ code: 'insufficient_funds' })
    await creditWallet(ctx.db, a.user.id, a.wallet.id, 1, { type: 'manual_credit' })
    const paid = await payOrder(ctx.db, payment)
    expect(paid.walletId).toBe(a.wallet.id)
    const secondQuote = await quoteFor(a.user.id)
    await expect(createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: secondQuote.id, walletId: a.wallet.id, hostname: 'second-deferred' })).rejects.toMatchObject({ code: 'insufficient_funds' })
  })

  it('counts already-active server renewals and never provisions twice on replay', async () => {
    const a = await account()
    const q = await quoteFor(a.user.id)
    await creditWallet(ctx.db, a.user.id, a.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    const first = await createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: q.id, walletId: a.wallet.id, hostname: 'existing-active' })
    expect((await handleProvision(ctx, { orderId: first.order.id })).status).toBe('provisioned')
    expect((await handleProvision(ctx, { orderId: first.order.id })).status).toBe('already_provisioned')
    const second = await quoteFor(a.user.id)
    await expect(createOrderFromQuote(ctx.db, { userId: a.user.id, quoteId: second.id, walletId: a.wallet.id, hostname: 'beyond-quota' })).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(await ctx.db.query.servers.findMany({ where: t => eq(t.userId, a.user.id) })).toHaveLength(1)
    expect(await ctx.db.query.providerOperations.findMany({ where: t => eq(t.referenceId, first.order.id) })).toHaveLength(1)
  })

  it('persists and audits coverage for admins, enforces policy changes and serializes concurrent orders at three days', async () => {
    const owner = await account(true), admin = await account(true), customer = await account()
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, owner.user.id))
    const key = 'billing.minimum_creation_coverage_days'
    const path = '/api/admin/settings/creation-funding'
    const save = (headers: Record<string, string>, minimumCoverageDays: number) => app.inject({ method: 'POST', url: path, headers, payload: { minimumCoverageDays } })
    const read = async () => (await app.inject(path.replace('/admin/settings/creation-funding', '/catalog/storefront'))).json().data.minimumCoverageDays
    expect(await read()).toBe(7)
    expect((await app.inject({ url: path, headers: admin.headers })).statusCode).toBe(403)
    expect((await save(admin.headers, 3)).statusCode).toBe(403)
    expect((await save(customer.headers, 3)).statusCode).toBe(403)
    for (const days of [0, 1.5, 31]) expect((await save(owner.headers, days)).statusCode).toBe(422)
    const [old, second] = await Promise.all([quoteFor(customer.user.id), quoteFor(customer.user.id)])
    const args = { userId: customer.user.id, walletId: customer.wallet.id }
    try {
      for (const days of [1, 7, 30, 3]) {
        expect((await save(owner.headers, days)).statusCode).toBe(200)
        expect(await read()).toBe(days)
        expect((await app.inject({ url: path, headers: owner.headers })).json().data.minimumCoverageDays).toBe(days)
        for (const [billingInterval, periods] of [['HOURLY', days * 24], ['DAILY', days], ['MONTHLY', 1]] as const) {
          await expect(ctx.db.transaction(tx => assertCreationFunding(tx, { ...args, totalRial: 100, billingInterval })))
            .rejects.toMatchObject({ code: 'insufficient_funds', details: { requiredBalanceRial: periods * 100, minimumCoverageDays: days } })
        }
      }
      expect((await ctx.db.query.settings.findFirst({ where: t => eq(t.key, key) }))?.value).toBe(3)
      const audit = await ctx.db.query.auditLogs.findMany({ where: t => eq(t.action, 'billing.creation_coverage_changed') })
      expect(audit).toContainEqual(expect.objectContaining({ actorId: owner.user.id, metadata: { previousDays: 30, minimumCoverageDays: 3 } }))
      expect(await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, customer.user.id) })).toHaveLength(0)
      const payload = { ...body(customer.wallet.id), expectedTotalRial: old.totalRial, expectedCoverageDays: 7 }
      const headers = await operationEmailHeaders(app, ctx.db, customer.user.id, customer.headers, { action: 'create', key: 'coverage-changed', payload })
      const response = await app.inject({ method: 'POST', url: '/api/servers', headers, payload })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'funding_policy_changed', details: { minimumCoverageDays: 3 } })
      expect(await ctx.db.query.orders.findMany({ where: t => eq(t.userId, customer.user.id) })).toHaveLength(0)
      await creditWallet(ctx.db, customer.user.id, customer.wallet.id, old.totalRial * 72, { type: 'manual_credit' })
      const orders = await Promise.allSettled([old, second].map(q => createOrderFromQuote(ctx.db, {
        ...args, quoteId: q.id, hostname: 'coverage-race', expectedCoverageDays: 3,
      })))
      expect(orders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(orders.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'insufficient_funds', details: { minimumCoverageDays: 3 } } })
      const ledger = await ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, customer.user.id) })
      expect(ledger.filter(row => row.type === 'purchase').map(row => row.amountRial)).toEqual([-old.totalRial])
    } finally {
      await ctx.db.delete(settings).where(eq(settings.key, key))
    }
  })

  it('keeps sales changes admin-only, audited, sync-stable and enforced on stale quotes while allowing admin purchases', async () => {
    const admin = await account(true)
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, admin.user.id))
    const customer = await account()
    const stale = await quoteFor(customer.user.id)
    const awaitingQuote = await quoteFor(customer.user.id)
    const awaiting = await createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: awaitingQuote.id, hostname: 'disabled-later' })
    const request = { method: 'PATCH' as const, url: '/api/admin/console/providers/hetzner', payload: { enabled: false } }
    expect((await app.inject(request)).statusCode).toBe(401)
    expect((await app.inject({ ...request, headers: customer.headers })).statusCode).toBe(403)
    expect((await app.inject({ ...request, headers: admin.headers })).statusCode).toBe(200)
    expect((await app.inject({ ...request, headers: admin.headers })).statusCode).toBe(200)
    expect(await ctx.db.query.auditLogs.findMany({ where: t => eq(t.action, 'provider.sales_changed') })).toHaveLength(1)
    expect((await app.inject('/api/catalog/storefront')).json().data.datacenters).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hetzner' })]))
    const customerCatalog = await app.inject({ url: '/api/catalog/storefront', headers: admin.headers })
    expect(customerCatalog.json().data.datacenters).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hetzner' })]))
    const adminCatalog = await app.inject({ url: '/api/catalog/storefront?adminPreview=true', headers: admin.headers })
    expect(adminCatalog.json().data.datacenters).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'hetzner' })]))
    expect(adminCatalog.headers['cache-control']).toBe('private, no-store')
    expect(adminCatalog.headers.vary).toContain('Authorization')
    await expect(quoteFor(customer.user.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createOrderFromQuote(ctx.db, { userId: customer.user.id, quoteId: stale.id, hostname: 'stale-quote' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(payOrder(ctx.db, { userId: customer.user.id, orderId: awaiting.order.id, walletId: customer.wallet.id })).rejects.toMatchObject({ code: 'forbidden' })
    const q = await quoteFor(admin.user.id)
    await creditWallet(ctx.db, admin.user.id, admin.wallet.id, q.totalRial * 168, { type: 'manual_credit' })
    expect((await createOrderFromQuote(ctx.db, { userId: admin.user.id, quoteId: q.id, walletId: admin.wallet.id, hostname: 'admin-checkout' })).created).toBe(true)
    await syncProviderCatalog(ctx.db, getProvider('hetzner'), { mode: 'live' })
    expect((await ctx.db.query.providers.findFirst({ where: t => eq(t.id, 'hetzner') }))!.enabled).toBe(false)
  })
})
