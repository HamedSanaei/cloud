import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq, inArray } from 'drizzle-orm'
import { DATABASE_URL, dbAvailable, getTestContext, truncateAll } from '../helpers.js'
import { createDb } from '../../src/db/index.js'
import type { TestContext } from '../helpers.js'
import { loadConfig } from '../../src/config.js'
import * as configuration from '../../src/config.js'
import { fxRates, providers, settings, users } from '../../src/db/schema.js'
import { getActiveFxRate, refreshEuroRate, euroRefreshIntervalMs, euroMarketSource, setFxRate, updatePricingRules, computePriceSnapshot } from '../../src/modules/pricing/service.js'
import { readMarketFxHealth } from '../../src/modules/pricing/market-fx.js'
import * as rateHistory from '../../src/modules/pricing/rate-history.js'
import { outboundFetch } from '../../src/modules/outbound/client.js'
import { OutboundError } from '../../src/modules/outbound/policy.js'
import { getStorefront } from '../../src/modules/catalog/storefront.js'
import { getHomeTariffs } from '../../src/modules/catalog/home-tariffs.js'
import { renderHomeTariffs } from '../../src/contracts/home-tariffs.js'
import { getProvider, registerProvider } from '../../src/modules/providers/registry.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { registerUser } from '../../src/modules/auth/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'

// This pricing suite deliberately serves a loopback ticker; network policy is
// exercised separately by outbound-routing/transport and outbound-settings tests.
vi.mock('../../src/modules/outbound/client.js', () => ({ outboundFetch: vi.fn() }))

describe.skipIf(!dbAvailable)('AbanTether EUR and USD = USDT pricing with a local-currency ledger', () => {
  let ctx: TestContext
  let ticker: HttpServer
  let baseUrl: string
  let marketPrice = '263881.12345678'
  let marketActive = true
  let httpStatus = 200
  let requests = 0
  let symbolOverride: string | null = null
  let unavailableCoin: string | null = null

  beforeAll(async () => {
    ctx = await getTestContext()
    ticker = createServer((request, response) => {
      requests++
      const coin = new URL(request.url!, 'http://fixture.local').searchParams.get('coin')
      response.writeHead(['USDT', 'EUR'].includes(coin!) && request.url?.startsWith('/api/v1/manager/otc/ticker?') ? (coin === unavailableCoin ? 503 : httpStatus) : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { markets: { [`${coin}IRT`]: { symbol: symbolOverride ?? coin, active: marketActive, buy_price: marketPrice } } } }))
    })
    await new Promise<void>((resolve) => ticker.listen(0, '127.0.0.1', resolve))
    const address = ticker.address()
    if (!address || typeof address === 'string') throw new Error('ticker fixture did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    await truncateAll(ctx.db)
    await ctx.db.delete(settings).where(inArray(settings.key, ['pricing.market_fx.EUR', 'pricing.market_fx.USDT']))
    marketPrice = '263881.12345678'
    marketActive = true
    httpStatus = 200
    requests = 0; symbolOverride = null; unavailableCoin = null
    vi.mocked(outboundFetch).mockReset().mockImplementation((_integration, url, init) => fetch(url, init))
    loadConfig({ ...process.env, NODE_ENV: 'test', USDT_RATE_API_BASE_URL: baseUrl, USDT_RATE_MAX_AGE_SECONDS: '60' })
  })
  afterAll(async () => {
    loadConfig(process.env)
    await new Promise<void>((resolve, reject) => ticker.close((error) => error ? reject(error) : resolve()))
    await ctx.close()
  })

  it('uses the Tether ask in toman times ten for both USD and USDT, preserving fractional cents', async () => {
    await ctx.db.insert(fxRates).values({ fromCurrency: 'USD', toCurrency: 'IRR', rate: '700000' })
    const [usdFx, usdtFx] = await Promise.all([getActiveFxRate(ctx.db, 'USD'), getActiveFxRate(ctx.db, 'USDT')])
    expect(usdFx.rate).toBe('2638811.234568')
    expect(usdtFx.rate).toBe('2638811.234568')
    await updatePricingRules(ctx.db, 'leaseweb.hourly', { markupPercent: 0, markupFixedRial: 0, taxPercent: 0, roundingToRial: 10 })
    for (const providerCurrency of ['USD', 'USDT']) {
      const snapshot = await computePriceSnapshot(ctx.db, { provider: 'leaseweb.hourly', providerCurrency, billingOption: { billingCycle: 'hourly', amount: '0.0055' }, fxRate: '1' })
      expect(snapshot.subtotalRial).toBe(14513)
      expect(snapshot.totalRial).toBe(14513)
    }

    const mock = ctx.mockProvider
    registerProvider({ ...mock, async syncCatalog() {
      const catalog = await mock.syncCatalog()
      return { ...catalog, offers: catalog.offers.map((offer) => ({ ...offer, category: 'cloud' as const, providerCurrency: 'USD', billingOptions: [{ billingCycle: 'hourly', amount: '0.0055' }] })) }
    } })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
    const user = await registerUser(ctx.db, { email: 'usd-funding@test.local', password: 'Dollar-funding-123!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    const quote = await createQuote(ctx.db, { userId: user.id, offerId: offer!.id, locationCode: 'FRA-01', billingOption: { billingCycle: 'hourly' }, billingPeriod: 'hourly', operatingSystem: 'ubuntu-24.04' })
    expect(quote.expiresAt.getTime()).toBeLessThanOrEqual(usdtFx.createdAt.getTime() + 60_000)
    await creditWallet(ctx.db, user.id, wallet.id, quote.totalRial * 168, { type: 'manual_credit' })
    const { order } = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: 'dollar-funded' })
    expect(order.currency).toBe('IRR')
    expect(order.totalRial).toBe(14513)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial).toBe(quote.totalRial * 167)
    const debit = await ctx.db.query.walletTransactions.findFirst({ where: (t) => and(eq(t.walletId, wallet.id), eq(t.type, 'purchase')) })
    expect(debit!.amountRial).toBe(-14513)
  })

  it('ignores a manual value and refreshes an expired market observation', async () => {
    await setFxRate(ctx.db, '1000000', { currency: 'USDT' })
    marketPrice = '200000'
    expect((await getActiveFxRate(ctx.db, 'USD')).rate).toBe('2000000.000000')
    await ctx.db.update(fxRates).set({ createdAt: new Date(Date.now() - 61000) }).where(eq(fxRates.fromCurrency, 'USDT'))
    marketPrice = '210000'
    expect((await getActiveFxRate(ctx.db, 'USD')).rate).toBe('2100000.000000')
  })

  it('refuses dollar pricing when fresh Tether is unavailable, even with historical USD and USDT rates', async () => {
    await ctx.db.insert(fxRates).values([
      { fromCurrency: 'USD', toCurrency: 'IRR', rate: '700000' },
      { fromCurrency: 'USDT', toCurrency: 'IRR', rate: '1000000', createdAt: new Date(Date.now() - 61000) },
    ])
    httpStatus = 503
    await expect(getActiveFxRate(ctx.db, 'USD')).rejects.toMatchObject({ code: 'usdt_rate_unavailable', status: 503 })
  })

  it.each([{ price: '0', active: true }, { price: '263881', active: false }])('rejects an unusable exchange market: $price / $active', async ({ price, active }) => {
    marketPrice = price
    marketActive = active
    await expect(getActiveFxRate(ctx.db, 'USD')).rejects.toMatchObject({ code: 'usdt_rate_unavailable' })
  })

  it('recovers missing EUR with exact toman × 10 conversion and one atomic history/audit entry across API/worker clients', async () => {
    const other = createDb(DATABASE_URL)
    try {
      const results = await Promise.all([refreshEuroRate(ctx.db), refreshEuroRate(other.db), getActiveFxRate(ctx.db, 'EUR')])
      expect(results.map(r => r.rate)).toEqual(Array(3).fill('2638811.234568'))
      expect(requests).toBe(1)
      const history = await ctx.db.query.fxRates.findMany()
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ fromCurrency: 'EUR', toCurrency: 'IRR', note: 'AbanTether EURIRT buy_price (toman × 10)', setBy: null })
      const audit = await ctx.db.query.auditLogs.findMany()
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ action: 'pricing.fx_rate.refreshed', metadata: { from: 'EUR', source: history[0]!.note } })
    } finally { await other.pool.end() }
  })

  it('coalesces duplicate observations and preserves old history after a half-hour refresh', async () => {
    const first = await refreshEuroRate(ctx.db)
    marketPrice = '300000'
    expect((await refreshEuroRate(ctx.db)).id).toBe(first.id)
    expect(requests).toBe(1)
    // A preceding slow HTTP response must not make the next scheduled refresh skip.
    const old = new Date(Date.now() - euroRefreshIntervalMs + 1000)
    await ctx.db.update(fxRates).set({ createdAt: old }).where(eq(fxRates.id, first.id!))
    const next = await refreshEuroRate(ctx.db)
    expect(next.rate).toBe('3000000.000000')
    expect(next.id).not.toBe(first.id)
    expect(requests).toBe(2)
    expect((await ctx.db.query.fxRates.findFirst({ where: t => eq(t.id, first.id!) }))!.createdAt).toEqual(old)
  })

  it('keeps the existing 24h fail-closed boundary during outages and recovers on a real observation', async () => {
    const [old] = await ctx.db.insert(fxRates).values({ fromCurrency: 'EUR', toCurrency: 'IRR', rate: '620000', note: euroMarketSource, createdAt: new Date(Date.now() - 3600000) }).returning()
    httpStatus = 503
    await expect(refreshEuroRate(ctx.db)).rejects.toMatchObject({ code: 'eur_rate_unavailable' })
    expect((await getActiveFxRate(ctx.db, 'EUR')).id).toBe(old!.id) // Existing valid observation; not freshened.
    const expired = new Date(Date.now() - 86400001)
    await ctx.db.update(fxRates).set({ createdAt: expired }).where(eq(fxRates.id, old!.id))
    await expect(getActiveFxRate(ctx.db, 'EUR')).rejects.toMatchObject({ code: 'eur_rate_unavailable', status: 503 })
    expect(await ctx.db.query.fxRates.findMany()).toHaveLength(1)
    expect((await ctx.db.query.fxRates.findFirst())!.createdAt).toEqual(expired)
    httpStatus = 200
    await delay(2050)
    expect((await getActiveFxRate(ctx.db, 'EUR')).rate).toBe('2638811.234568')
  })

  it('ignores future EUR rows instead of using them or substituting USDT', async () => {
    await ctx.db.insert(fxRates).values([
      { fromCurrency: 'EUR', toCurrency: 'IRR', rate: '1', createdAt: new Date(Date.now() + 3600000) },
      { fromCurrency: 'USDT', toCurrency: 'IRR', rate: '2' },
    ])
    const rate = await getActiveFxRate(ctx.db, 'EUR')
    expect(rate.rate).toBe('2638811.234568')
    expect(rate.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
    expect(requests).toBe(1)
  })

  it.each([{ price: '0', active: true }, { price: '-1', active: true }, { price: 'NaN', active: true }, { price: '1.123456789', active: true }, { price: '200000', active: false }])('rejects invalid EUR without a history row: $price / $active', async ({ price, active }) => {
    marketPrice = price; marketActive = active
    await expect(getActiveFxRate(ctx.db, 'EUR')).rejects.toMatchObject({ code: 'eur_rate_unavailable' })
    expect(await ctx.db.query.fxRates.findMany()).toHaveLength(0)
  })

  it('rejects a different market symbol even if it is placed in the EURIRT response slot', async () => {
    symbolOverride = 'USDT'
    await expect(getActiveFxRate(ctx.db, 'EUR')).rejects.toMatchObject({ code: 'eur_rate_unavailable' })
    expect(await ctx.db.query.fxRates.findMany()).toHaveLength(0)
  })

  it.each([
    ['timeout', new DOMException('fixture', 'TimeoutError'), 2],
    ['dns', Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }), 2],
    ['policy', new OutboundError('policy'), 1],
  ])('handles transport failure %s without a new FX row', async (label, error, attempts) => {
    const outbound = vi.mocked(outboundFetch)
    outbound.mockRejectedValue(error)
    await expect(getActiveFxRate(ctx.db, 'EUR')).rejects.toMatchObject({ code: 'eur_rate_unavailable' })
    expect(outbound).toHaveBeenCalledTimes(attempts)
    expect((await readMarketFxHealth(ctx.db))[0]).toMatchObject({ market: 'EUR', health: 'missing', failures: 1, error: label })
    expect(await ctx.db.query.fxRates.findMany()).toHaveLength(0)
  })

  it('rolls back an incomplete rate and audit and alerts the superadmin', async () => {
    const admin = await registerUser(ctx.db, { email: 'fx-monitor@test.local', password: 'FX-fixture-only-123!' })
    await ctx.db.update(users).set({ role: 'super_admin' }).where(eq(users.id, admin.id))
    const save = rateHistory.saveFxRate
    const failure = vi.spyOn(rateHistory, 'saveFxRate').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new Error('temporary persistence failure')
    })
    try {
      await expect(refreshEuroRate(ctx.db)).rejects.toMatchObject({ code: 'eur_rate_unavailable' })
      expect(await ctx.db.query.fxRates.findMany()).toHaveLength(0)
      expect(await ctx.db.query.auditLogs.findMany({ where: t => eq(t.action, 'pricing.fx_rate.refreshed') })).toHaveLength(0)
      expect((await readMarketFxHealth(ctx.db))[0]).toMatchObject({ error: 'db_write', failures: 1 })
      expect(await ctx.db.query.notifications.findFirst({ where: t => eq(t.userId, admin.id) })).toMatchObject({ type: 'error' })
      await delay(2050)
      expect((await getActiveFxRate(ctx.db, 'EUR')).rate).toBe('2638811.234568')
      expect((await readMarketFxHealth(ctx.db))[0]).toMatchObject({ error: null, failures: 0, health: 'fresh' })
    } finally { failure.mockRestore() }
  })

  it.each([
    { blocked: 'hetzner', blockedCurrency: 'EUR', available: 'leaseweb', currency: 'USD', admin: false },
    { blocked: 'leaseweb', blockedCurrency: 'GBP', available: 'hetzner', currency: 'EUR', admin: true },
  ] as const)('keeps $available orderable while $blocked has no usable $blockedCurrency rate', async ({ blocked, blockedCurrency, available, currency, admin }) => {
    const mock = ctx.mockProvider
    for (const [id, providerCurrency] of [[blocked, blockedCurrency], [available, currency]] as const) {
      registerProvider({ ...mock, id, async syncCatalog() {
        const catalog = await mock.syncCatalog()
        return { ...catalog, offers: catalog.offers.map(offer => ({ ...offer, provider: id, category: 'cloud' as const, providerCurrency,
          billingOptions: [{ billingCycle: 'hourly', amount: '0.0055' }] })) }
      } })
      await syncProviderCatalog(ctx.db, getProvider(id), { mode: 'live' })
      await enableAllOffersForSale(ctx.db, id)
      await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, id))
    }
    const base = configuration.getConfig()
    const config = vi.spyOn(configuration, 'getConfig').mockReturnValue({ ...base, DATA_AUTHORITY: 'site', PROVIDERS: {
      ...base.PROVIDERS,
      hetzner: { ...base.PROVIDERS.hetzner, enabled: true, orderingEnabled: true },
      leaseweb: { ...base.PROVIDERS.leaseweb, enabled: true, orderingEnabled: true },
    } })
    try {
      if (admin) await ctx.db.update(providers).set({ enabled: false }).where(eq(providers.id, blocked))
      if (blockedCurrency === 'EUR') unavailableCoin = 'EUR'
      else await ctx.db.insert(fxRates).values({ fromCurrency: 'GBP', toCurrency: 'IRR', rate: '700000', createdAt: new Date(Date.now() - 2 * 86400000) })
      const storefront = await getStorefront(ctx.db, admin)
      expect(storefront.datacenters.map(item => item.id)).toEqual([available])
      expect(storefront.pricingUnavailable.map(item => item.id)).toEqual([blocked])
      expect(storefront.offers.length).toBeGreaterThan(0)
      expect(storefront.offers.every(item => item.provider === available && item.prices[0]!.totalRial > 0)).toBe(true)
    } finally {
      config.mockRestore()
      if (admin) await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, blocked))
    }
  })

  it('restores real public Hetzner retail and SSR prices with a valid EUR observation', async () => {
    await getActiveFxRate(ctx.db, 'EUR')
    const mock = ctx.mockProvider
    registerProvider({ ...mock, id: 'hetzner', async syncCatalog() {
      const catalog = await mock.syncCatalog()
      return { ...catalog, offers: catalog.offers.map(offer => ({ ...offer, provider: 'hetzner', category: 'cloud' as const, providerCurrency: 'EUR' })) }
    } })
    // Only disposable mock catalog/retail rows: no provider order or wallet action.
    await syncProviderCatalog(ctx.db, getProvider('hetzner'))
    await enableAllOffersForSale(ctx.db, 'hetzner')
    await ctx.db.update(providers).set({ enabled: true }).where(eq(providers.id, 'hetzner'))
    const base = configuration.getConfig()
    const config = vi.spyOn(configuration, 'getConfig').mockReturnValue({ ...base, DATA_AUTHORITY: 'site',
      PROVIDERS: { ...base.PROVIDERS, hetzner: { ...base.PROVIDERS.hetzner, enabled: true, orderingEnabled: true } } })
    try {
      const tariffs = await getHomeTariffs(ctx.db)
      expect(tariffs.meta.status).toBe('available')
      expect(tariffs.hetzner!.length).toBeGreaterThan(0)
      expect(renderHomeTariffs(tariffs.iran, tariffs.hetzner, tariffs.meta)).toContain('تومان')
      expect(await ctx.db.query.orders.findMany()).toHaveLength(0)
      expect(await ctx.db.query.walletTransactions.findMany()).toHaveLength(0)
    } finally { config.mockRestore() }
  })
})
