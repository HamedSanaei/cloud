import { and, eq, lt } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { quotes } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { getOffer } from '../catalog/service.js'
import { computePriceSnapshot } from '../pricing/service.js'
import type { ProviderBillingOption, ProviderSlaOption } from '../providers/provider.interface.js'

export interface CreateQuoteInput {
  userId: string
  offerId: string
  locationCode: string
  billingOption: ProviderBillingOption
  operatingSystem?: string
  serviceLevel?: ProviderSlaOption
}

export async function createQuote(db: DbClient, input: CreateQuoteInput) {
  const offer = await getOffer(db, input.offerId)
  if (!offer.enabled || !offer.available) throw new ValidationError('این محصول فعلاً قابل سفارش نیست')
  if (offer.provider !== 'leaseweb') throw new ValidationError('Provider not supported')

  const billingOptions = (offer.billingOptions ?? []) as ProviderBillingOption[]
  const matched = billingOptions.find(
    (b) =>
      b.billingCycle === input.billingOption.billingCycle &&
      String(b.contractTerm ?? '') === String(input.billingOption.contractTerm ?? ''),
  )
  if (!matched) {
    throw new ValidationError('گزینه صورتحساب انتخابی برای این محصول موجود نیست')
  }

  const snapshot = await computePriceSnapshot(db, {
    provider: offer.provider,
    providerCurrency: offer.providerCurrency,
    billingOption: matched,
  })

  const ttlMinutes = getConfig().QUOTE_TTL_MINUTES
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000)

  const [quote] = await db
    .insert(quotes)
    .values({
      userId: input.userId,
      productId: offer.id,
      locationId: offer.locationId,
      provider: offer.provider,
      providerProductId: offer.providerProductId,
      providerCurrency: snapshot.providerCurrency,
      providerAmountCents: snapshot.providerAmountCents,
      fxRate: snapshot.fxRate,
      markupPercent: snapshot.markupPercent,
      markupFixedRial: snapshot.markupFixedRial,
      taxPercent: snapshot.taxPercent,
      subtotalRial: snapshot.subtotalRial,
      taxRial: snapshot.taxRial,
      totalRial: snapshot.totalRial,
      billingInterval: 'MONTHLY',
      billingOption: matched as never,
      operatingSystem: input.operatingSystem ?? null,
      serviceLevel: input.serviceLevel ?? null,
      expiresAt,
    })
    .returning()
  if (!quote) throw new Error('failed to create quote')
  return quote
}

export async function getQuote(db: DbClient, userId: string, quoteId: string) {
  const quote = await db.query.quotes.findFirst({ where: (t) => eq(t.id, quoteId) })
  if (!quote || quote.userId !== userId) throw new NotFoundError('استعلام قیمت یافت نشد')
  return quote
}

export async function assertQuoteValid(db: DbOrTx, quote: typeof quotes.$inferSelect) {
  if (quote.status !== 'valid') throw new ValidationError('استعلام قیمت دیگر معتبر نیست')
  if (quote.expiresAt < new Date()) {
    await db.update(quotes).set({ status: 'expired' }).where(eq(quotes.id, quote.id))
    throw new ValidationError('استعلام قیمت منقضی شده است — لطفاً دوباره استعلام بگیرید')
  }
}

export async function markQuoteAccepted(db: DbOrTx, quoteId: string) {
  await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId))
}

/**
 * Lock a quote row (SELECT ... FOR UPDATE) inside an order transaction so two
 * concurrent orders can never consume the same quote.
 */
export async function lockQuote(db: DbOrTx, quoteId: string) {
  const rows = await db.select().from(quotes).where(eq(quotes.id, quoteId)).for('update').limit(1)
  const quote = rows[0]
  if (!quote) throw new NotFoundError('استعلام قیمت یافت نشد')
  return quote
}

/** Expire stale quotes (run by a background job or on demand). */
export async function expireStaleQuotes(db: DbClient): Promise<number> {
  const res = await db
    .update(quotes)
    .set({ status: 'expired' })
    .where(and(eq(quotes.status, 'valid'), lt(quotes.expiresAt, new Date())))
    .returning({ id: quotes.id })
  return res.length
}