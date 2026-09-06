import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getTestContext, truncateAll, dbAvailable } from '../helpers.js'
import { providerProducts } from '../../src/db/schema.js'
import { registerUser } from '../../src/modules/auth/service.js'
import {
  syncProviderCatalog,
  enableAllOffersForSale,
  findOfferByProductAndLocation,
} from '../../src/modules/catalog/service.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { createQuote } from '../../src/modules/quotes/service.js'
import { createOrderFromQuote } from '../../src/modules/orders/service.js'
import { getProvider } from '../../src/modules/providers/registry.js'
import { ensureDefaultWallet, creditWallet } from '../../src/modules/wallets/service.js'
import { ValidationError } from '../../src/lib/errors.js'

const skip = !dbAvailable

describe.skipIf(skip)('catalog retail safety (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    await setFxRate(ctx.db, '620000', { note: 'test fixture' })
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    await enableAllOffersForSale(ctx.db)
  })

  afterAll(async () => {
    await ctx.close()
  })

  async function fundedUser(email: string) {
    const user = await registerUser(ctx.db, { email, password: 'Pass123456!' })
    const wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 100_000_000, { type: 'manual_credit', description: 'تست' })
    return { user, wallet }
  }

  // VPS02_4 exists in several locations; quotes always resolve the FRA-01
  // row, so all assertions must target exactly that row.
  async function offerRow() {
    const offer = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS02_4', 'FRA-01')
    expect(offer).toBeTruthy()
    return offer!
  }

  async function makeQuote(userId: string) {
    const offer = await offerRow()
    return createQuote(ctx.db, {
      userId,
      offerId: offer.id,
      locationCode: 'FRA-01',
      billingOption: { billingCycle: 'monthly', contractTerm: 0 },
      operatingSystem: 'ubuntu-24.04',
    })
  }

  it('newly synced offers are not enabled for retail sale until admin approval', async () => {
    // Drop one product (never quoted) and re-sync: the re-discovered rows must
    // default to enabled=false even though other products were enabled before.
    await ctx.db.delete(providerProducts).where(eq(providerProducts.providerProductId, 'VPS04_8'))
    const res = await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    expect(res.products).toBeGreaterThan(0)
    const fresh = await findOfferByProductAndLocation(ctx.db, 'leaseweb', 'VPS04_8', 'FRA-01')
    expect(fresh).toBeTruthy()
    expect(fresh!.enabled).toBe(false)
    await expect(
      createQuote(ctx.db, {
        userId: '00000000-0000-0000-0000-000000000001',
        offerId: fresh!.id,
        locationCode: 'FRA-01',
        billingOption: { billingCycle: 'monthly', contractTerm: 0 },
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    // Re-enable for the remaining tests.
    await enableAllOffersForSale(ctx.db)
  })

  it('catalog sync is idempotent and classifies billing options centrally', async () => {
    const before = await ctx.db.query.providerProducts.findMany()
    await syncProviderCatalog(ctx.db, getProvider('leaseweb'))
    const after = await ctx.db.query.providerProducts.findMany()
    expect(after.length).toBe(before.length)

    // No duplicated product/location combinations.
    const key = (r: { provider: string; providerProductId: string; locationId: string | null }) =>
      `${r.provider}|${r.providerProductId}|${r.locationId}`
    expect(new Set(after.map(key)).size).toBe(after.length)

    // Classifier output attached at sync: every stored option carries a
    // classification and the exact provider values.
    const sample = after.find((r) => r.providerProductId === 'VPS02_4' && r.billingOptions != null)!
    const options = sample.billingOptions as Array<{
      classification?: string
      billingCycle: string
      contractTerm?: number
    }>
    expect(options.length).toBeGreaterThanOrEqual(2)
    expect(options.some((o) => o.classification === 'MONTH_TO_MONTH' && o.contractTerm === 0)).toBe(true)
    expect(options.some((o) => o.classification === 'MONTHLY_BILLING_LONG_TERM_COMMITMENT' && o.contractTerm === 12)).toBe(true)
    // The legacy mock-only monthly flag must not exist in stored options.
    for (const o of options) {
      expect('monthly' in o).toBe(false)
    }
  })

  it('refuses quotes when the catalog is stale (CATALOG_MAX_AGE_MINUTES)', async () => {
    const offer = await offerRow()
    await ctx.db
      .update(providerProducts)
      .set({ lastSyncedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
      .where(eq(providerProducts.id, offer.id))
    const { user } = await fundedUser('stale@test.local')
    await expect(makeQuote(user.id)).rejects.toBeInstanceOf(ValidationError)
    // Restore freshness for later tests.
    await ctx.db
      .update(providerProducts)
      .set({ lastSyncedAt: new Date() })
      .where(eq(providerProducts.id, offer.id))
  })

  it('new quotes use the new provider price; existing quotes keep their snapshot', async () => {
    const { user } = await fundedUser('price@test.local')
    const offer = await offerRow()
    const before = (offer.billingOptions as Array<{ amountCents?: number }>)[0]?.amountCents ?? offer.providerPriceCents!

    const quoteA = await makeQuote(user.id)
    expect(quoteA.totalRial).toBe(11_238_000) // 1450 EUR-cents snapshot

    // Provider raises the price in the monthly billing option.
    const newOptions = JSON.parse(JSON.stringify(offer.billingOptions)) as Array<Record<string, unknown>>
    for (const b of newOptions) {
      if (b.classification === 'MONTH_TO_MONTH') {
        b.amountCents = 3000
        b.amount = '30.00'
      }
    }
    await ctx.db
      .update(providerProducts)
      .set({ billingOptions: newOptions as never })
      .where(eq(providerProducts.id, offer.id))

    const quoteB = await makeQuote(user.id)
    expect(quoteB.totalRial).not.toBe(quoteA.totalRial)
    expect(quoteB.providerAmountCents).toBe(3000)
    // quoteA retains the old snapshot even after the provider price changed.
    expect(quoteA.providerAmountCents).toBe(before)

    // Paid orders created from the old quote never change retroactively.
    const { user: u2, wallet } = await fundedUser('price2@test.local')
    const quoteC = await makeQuote(u2.id) // still new price
    const { order } = await createOrderFromQuote(ctx.db, {
      userId: u2.id,
      quoteId: quoteC.id,
      walletId: wallet.id,
      hostname: 'price-frozen-vps',
      idempotencyKey: 'price-frozen-1',
    })
    const invoice = await ctx.db.query.invoices.findFirst({
      where: (t) => eq(t.orderId, order.id),
    })
    expect(invoice).toBeTruthy()
    const invoiceTotal = invoice!.totalRial

    // Change the price again — the paid order/invoice must stay frozen.
    const options2 = JSON.parse(JSON.stringify(offer.billingOptions)) as Array<Record<string, unknown>>
    for (const b of options2) {
      if (b.classification === 'MONTH_TO_MONTH') {
        b.amountCents = 5000
        b.amount = '50.00'
      }
    }
    await ctx.db
      .update(providerProducts)
      .set({ billingOptions: options2 as never })
      .where(eq(providerProducts.id, offer.id))
    const invoiceAfter = await ctx.db.query.invoices.findFirst({
      where: (t) => eq(t.orderId, order.id),
    })
    expect(invoiceAfter!.totalRial).toBe(invoiceTotal)
  })

  it('a product that disappears from the provider cannot be quoted, existing orders are untouched', async () => {
    const { user: buyer, wallet } = await fundedUser('gone@test.local')
    const quote = await makeQuote(buyer.id)
    const { order } = await createOrderFromQuote(ctx.db, {
      userId: buyer.id,
      quoteId: quote.id,
      walletId: wallet.id,
      hostname: 'gone-vps',
      idempotencyKey: 'gone-order-1',
    })
    expect(order.status).toBe('paid')

    const offer = await offerRow()
    await ctx.db
      .update(providerProducts)
      .set({ available: false })
      .where(eq(providerProducts.id, offer.id))

    const { user: late } = await fundedUser('late@test.local')
    await expect(makeQuote(late.id)).rejects.toBeInstanceOf(ValidationError)

    // Existing paid order and its invoice are still intact.
    const orderAfter = await ctx.db.query.orders.findFirst({ where: (t) => eq(t.id, order.id) })
    expect(orderAfter!.status).toBe('paid')
    const invoice = await ctx.db.query.invoices.findFirst({ where: (t) => eq(t.orderId, order.id) })
    expect(invoice).toBeTruthy()
  })
})