import { and, eq, lt, lte, gte, gt, isNotNull, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { AppError, ValidationError } from '../../lib/errors.js'
import { computePriceFromRules, euroMarketSource, fxMaxAgeMs, type PricingRuleValues } from './service.js'

const renewalPriceBlockCodes = new Set(['renewal_price_unavailable', 'renewal_rules_unavailable', 'renewal_fx_unavailable'])
export const latestApprovedEuro = (db: DbOrTx, asOf: Date) => db.query.fxRates.findFirst({
  where: t => and(eq(t.fromCurrency, 'EUR'), eq(t.toCurrency, 'IRR'), lte(t.createdAt, asOf), gt(t.rate, '0'), lt(t.rate, '100000000000000'),
    or(isNotNull(t.setBy), eq(t.note, euroMarketSource))),
  orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
})
export type RenewalFx = { asOf: Date; latest: Awaited<ReturnType<typeof latestApprovedEuro>> }

export function isRenewalPriceBlocked(error: unknown): error is AppError {
  return error instanceof AppError && renewalPriceBlockCodes.has(error.code)
}

/** Historical pricing takes priority over the approved observation frozen for the sweep. */
export async function renewalPrice(db: DbOrTx, orderId: string, interval: string, periodStart: Date, fallback?: RenewalFx) {
  const order = await db.query.orders.findFirst({ where: t => eq(t.id, orderId) })
  // A confirmed resize changes the next period's cost basis, never a paid invoice.
  const server = await db.query.servers.findFirst({ where: t => eq(t.orderId, orderId) })
  const resize = server ? await db.query.providerOperations.findFirst({
    where: t => and(eq(t.referenceId, server.id), eq(t.referenceType, 'server'), eq(t.action, 'resize'), eq(t.status, 'succeeded'),
      interval === 'HOURLY' ? lte(t.completedAt, periodStart) : undefined),
    orderBy: (t, { desc }) => [desc(t.completedAt)],
  }) : null
  const resizeQuote = (resize?.requestMetadata as { input?: { quoteId?: string } } | null)?.input?.quoteId
  const quoteId = resizeQuote ?? order?.quoteId
  const quote = quoteId && order ? await db.query.quotes.findFirst({ where: t => and(eq(t.id, quoteId), eq(t.userId, order.userId)) }) : null
  if (!order || !quote) throw new AppError(503, 'renewal_price_unavailable', 'مبنای معتبر قیمت تمدید در دسترس نیست')
  const product = quote.productId ? await db.query.providerProducts.findFirst({ where: t => eq(t.id, quote.productId!) }) : null
  const provider = order.provider === 'leaseweb' && (product?.category === 'cloud' || interval === 'HOURLY') ? 'leaseweb.hourly' : order.provider
  let rules = await db.query.pricingRules.findFirst({ where: t => eq(t.provider, provider) })
  if (!rules) throw new AppError(503, 'renewal_price_unavailable', 'قواعد قیمت تمدید در دسترس نیست')
  const currency = quote.providerCurrency === 'USD' ? 'USDT' : quote.providerCurrency
  const now = fallback?.asOf ?? new Date()
  const hourEnd = new Date(Math.floor(periodStart.getTime() / 3600000) * 3600000 + 3600000 - 1)
  const cutoff = interval === 'HOURLY' ? new Date(Math.min(now.getTime(), hourEnd.getTime())) : now
  if (rules.updatedAt > cutoff) {
    // Each atomic edit records the rule immediately preceding it. The first
    // edit after this hour therefore identifies the rule in force at cutoff.
    const edit = provider === 'hetzner' ? await db.query.auditLogs.findFirst({
      where: t => and(eq(t.action, 'admin.price_rule.changed'), eq(t.targetId, rules!.id),
        sql`${t.metadata}->'after'->>'updatedAt' > ${cutoff.toISOString()}`),
      orderBy: t => [sql`${t.metadata}->'after'->>'updatedAt' asc`],
    }) : undefined
    const before = (edit?.metadata as { before?: PricingRuleValues & { updatedAt: string } } | undefined)?.before
    if (!before || !Number.isFinite(Date.parse(before.updatedAt)) || Date.parse(before.updatedAt) > cutoff.getTime()) {
      throw new AppError(503, 'renewal_rules_unavailable', 'قواعد قیمت تاریخی این ساعت در دسترس نیست؛ برداشت انجام نشد')
    }
    rules = { ...rules, ...before, updatedAt: new Date(before.updatedAt) }
  }
  const oldest = new Date(cutoff.getTime() - fxMaxAgeMs(currency))
  const historical = currency === 'IRR' ? { id: null, rate: '1', createdAt: cutoff, note: 'IRR identity' } : await db.query.fxRates.findFirst({
    where: t => and(eq(t.fromCurrency, currency), eq(t.toCurrency, 'IRR'), lte(t.createdAt, cutoff), gte(t.createdAt, oldest),
      gt(t.rate, '0'), lt(t.rate, '100000000000000')),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
  })
  const alternate = !historical && interval === 'HOURLY' && order.provider === 'hetzner' && currency === 'EUR' ? fallback?.latest : undefined
  const fx = historical ?? alternate
  if (!fx) throw new AppError(503, 'renewal_fx_unavailable', 'نرخ معتبر ارز برای ساعت تمدید در دسترس نیست؛ برداشت انجام نشد')
  let price: ReturnType<typeof computePriceFromRules>
  try {
    price = computePriceFromRules({ providerCurrency: quote.providerCurrency, providerAmountCents: quote.providerAmountCents, fxRate: fx.rate, rules })
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error
    throw new AppError(503, 'renewal_price_unavailable', 'مبلغ معتبر تمدید قابل محاسبه نیست؛ برداشت انجام نشد')
  }
  return { ...price, fxRateId: fx.id, fxRate: fx.rate, fxAt: fx.createdAt.toISOString(), fxSource: alternate ? (alternate.setBy ? 'operator-approved' : euroMarketSource) : fx.note,
    ...(alternate ? { fxFallback: true as const, fxSelectionPolicy: 'latest_available_approved_observation', fxSelectedAt: now.toISOString(),
      fxAgeMs: now.getTime() - alternate.createdAt.getTime(), fxFallbackReason: 'renewal_fx_unavailable' } : {}),
    ruleId: rules.id, ruleVersion: rules.updatedAt.toISOString(), calculatedAt: now.toISOString(), ledgerPrecisionRial: 1 }
}

/** Estimates reuse an already-issued unpaid invoice before considering newer FX. */
export async function fundingPrice(db: DbOrTx, sub: { id: string; orderId: string | null; billingInterval: string; priceRial: number }) {
  if (!['HOURLY', 'MONTHLY'].includes(sub.billingInterval)) return sub.priceRial
  const invoice = await db.query.invoices.findFirst({ where: t => and(eq(t.subscriptionId, sub.id), eq(t.status, 'open')), orderBy: (t, { asc }) => [asc(t.createdAt)] })
  return invoice?.totalRial ?? (await renewalPrice(db, sub.orderId!, sub.billingInterval, new Date())).totalRial
}
