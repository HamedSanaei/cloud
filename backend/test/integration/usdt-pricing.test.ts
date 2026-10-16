import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { and, eq } from 'drizzle-orm'
import { dbAvailable, getTestContext, truncateAll } from '../helpers.js'
import type { TestContext } from '../helpers.js'
import { loadConfig } from '../../src/config.js'
import { fxRates } from '../../src/db/schema.js'
import { getActiveFxRate, setFxRate, updatePricingRules, computePriceSnapshot } from '../../src/modules/pricing/service.js'
import { getProvider, registerProvider } from '../../src/modules/providers/registry.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { registerUser } from '../../src/modules/auth/service.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'

describe.skipIf(!dbAvailable)('USD = USDT pricing with a local-currency ledger', () => {
  let ctx: TestContext
  let ticker: HttpServer
  let baseUrl: string
  let marketPrice = '263881.12345678'
  let marketActive = true
  let httpStatus = 200

  beforeAll(async () => {
    ctx = await getTestContext()
    ticker = createServer((request, response) => {
      response.writeHead(request.url === '/api/v1/manager/otc/ticker?coin=USDT' ? httpStatus : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { markets: { USDTIRT: { symbol: 'USDT', active: marketActive, buy_price: marketPrice } } } }))
    })
    await new Promise<void>((resolve) => ticker.listen(0, '127.0.0.1', resolve))
    const address = ticker.address()
    if (!address || typeof address === 'string') throw new Error('ticker fixture did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    await truncateAll(ctx.db)
    marketPrice = '263881.12345678'
    marketActive = true
    httpStatus = 200
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
      expect(snapshot.totalRial).toBe(14510)
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
    await creditWallet(ctx.db, user.id, wallet.id, 1000000, { type: 'manual_credit' })
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    const quote = await createQuote(ctx.db, { userId: user.id, offerId: offer!.id, locationCode: 'FRA-01', billingOption: { billingCycle: 'hourly' }, billingPeriod: 'hourly', operatingSystem: 'ubuntu-24.04' })
    const { order } = await createOrderFromQuote(ctx.db, { userId: user.id, quoteId: quote.id, walletId: wallet.id, hostname: 'dollar-funded' })
    expect(order.currency).toBe('IRR')
    expect(order.totalRial).toBe(14510)
    expect((await ctx.db.query.wallets.findFirst({ where: (t) => eq(t.id, wallet.id) }))!.balanceRial).toBe(985490)
    const debit = await ctx.db.query.walletTransactions.findFirst({ where: (t) => and(eq(t.walletId, wallet.id), eq(t.type, 'purchase')) })
    expect(debit!.amountRial).toBe(-14510)
  })

  it('refreshes an expired Tether quote instead of using a fiat-dollar rate', async () => {
    await setFxRate(ctx.db, '1000000', { currency: 'USDT' })
    marketPrice = '200000'
    expect((await getActiveFxRate(ctx.db, 'USD')).rate).toBe('1000000.000000')
    await ctx.db.update(fxRates).set({ createdAt: new Date(Date.now() - 61000) }).where(eq(fxRates.fromCurrency, 'USDT'))
    expect((await getActiveFxRate(ctx.db, 'USD')).rate).toBe('2000000.000000')
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
})
