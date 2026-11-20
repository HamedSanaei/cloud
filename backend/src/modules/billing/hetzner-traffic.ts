import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { hetznerTrafficPeriods, invoiceItems, invoices, servers, subscriptions, users } from '../../db/schema.js'
import { formatTrafficTb, isTrafficByteCount } from '../../contracts/home-tariffs.js'
import { AppError, ValidationError } from '../../lib/errors.js'
import { recordEvent } from '../system/events.js'
import { customerProvider } from '../servers/management.js'
import { hetznerTrafficTariff } from '../pricing/hetzner-traffic.js'
import { exactProviderCents } from '../pricing/periods.js'
import { computePriceFromRules, fxMaxAgeMs, getPricingRules } from '../pricing/service.js'
import type { RenewalFx } from '../pricing/renewal.js'
import { applyWalletTransaction, getWallet } from '../wallets/service.js'
import { generateNumber } from '../orders/service.js'
import { publishNotification } from '../notifications/service.js'
import { getConfig } from '../../config.js'
import { findOfferByProductAndLocation } from '../catalog/service.js'

const blockBytes = 100_000_000
const blocksPerTb = 10_000
const cutoverKey = 'billing.hetzner_traffic_cutover'
const utcMonth = (at: Date) => at.toISOString().slice(0, 7)
const utcHour = (at: Date) => Math.floor(at.getTime() / 3_600_000)
export const cumulativeTrafficBlocks = (outgoing: number, included: number) => Math.ceil(Math.max(0, outgoing - included) / blockBytes)
type Period = typeof hetznerTrafficPeriods.$inferSelect
type Server = typeof servers.$inferSelect
type Subscription = typeof subscriptions.$inferSelect
type Observed = Pick<Period, 'providerServerId' | 'outgoingBytes' | 'includedBytes' | 'location' | 'serverType' | 'observedAt'>

function billable(server: Server | undefined): server is Server & { providerServerId: string; subscriptionId: string } {
  return !!server && server.provider === 'hetzner' && !!server.providerServerId && !!server.subscriptionId
    && !server.terminatedAt && [null, 'delete_failed'].includes(server.terminationState)
    && ['active', 'suspended'].includes(server.status)
}

const mostRecent = (db: DbOrTx, serverId: string) => db.query.hetznerTrafficPeriods.findFirst({
  where: t => eq(t.serverId, serverId), orderBy: t => [desc(t.month)],
})
const cutover = (db: DbOrTx) => db.query.settings.findFirst({ where: t => eq(t.key, cutoverKey) })

export function nextTrafficPeriod(previous: Period | undefined, sample: Observed, omitHistorical: boolean) {
  const month = utcMonth(sample.observedAt)
  if (previous && (previous.observedAt >= sample.observedAt || previous.providerServerId !== sample.providerServerId)) return null
  const sameMonth = previous?.month === month
  if (previous && (sameMonth ? sample.outgoingBytes < previous.outgoingBytes
    : previous.outgoingBytes !== 0 && sample.outgoingBytes >= previous.outgoingBytes)) return null
  return { ...sample, month, previousOutgoingBytes: sameMonth ? previous.outgoingBytes : 0,
    excludedBlocks: sameMonth ? previous.excludedBlocks : omitHistorical && !previous ? cumulativeTrafficBlocks(sample.outgoingBytes, sample.includedBytes) : 0,
    paidBlocks: sameMonth ? previous.paidBlocks : 0 }
}

/** External I/O stays outside renewal and wallet transactions. One valid read per UTC hour. */
export async function observeHetznerTraffic(db: DbClient, server: Server | undefined, at: Date) {
  if (!billable(server)) return false
  try {
    const rollout = await cutover(db)
    if (rollout?.value !== true) return false
    const recent = await mostRecent(db, server.id)
    if (recent?.providerServerId === server.providerServerId && utcHour(recent.observedAt) === utcHour(at)) return true
    const view = await customerProvider(server).inspect(server.providerServerId)
    const meta = view.metadata
    if (view.providerServerId !== server.providerServerId || !isTrafficByteCount(meta?.outgoingTrafficBytes)
      || !isTrafficByteCount(meta?.includedTrafficBytes) || typeof meta?.serverType !== 'string' || typeof meta.location !== 'string') {
      recordEvent('billing.hetzner_traffic_observation_invalid', 'warn', 'billing', { serverId: server.id, code: 'traffic_counter_unavailable' })
      return false
    }
    // A response crossing the month/hour boundary cannot safely attest to the old bucket.
    const observedAt = new Date()
    if (utcHour(observedAt) !== utcHour(at)) return false
    const sample = { providerServerId: view.providerServerId, outgoingBytes: meta.outgoingTrafficBytes,
      includedBytes: meta.includedTrafficBytes, serverType: meta.serverType, location: meta.location, observedAt }
    return db.transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
      const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
      if (!billable(current) || current.providerServerId !== server.providerServerId || current.subscriptionId !== server.subscriptionId) return false
      const previous = await mostRecent(tx, server.id)
      if (previous && utcHour(previous.observedAt) === utcHour(at)) return true
      const next = nextTrafficPeriod(previous, sample, (current.activatedAt ?? current.createdAt) <= rollout.updatedAt)
      if (!next) {
        recordEvent('billing.hetzner_traffic_counter_unconfirmed', 'warn', 'billing', { serverId: server.id, code: 'traffic_counter_unconfirmed' })
        return false
      }
      if (previous?.month === next.month) await tx.update(hetznerTrafficPeriods).set(next).where(eq(hetznerTrafficPeriods.id, previous.id))
      else await tx.insert(hetznerTrafficPeriods).values({ ...next, serverId: current.id, subscriptionId: current.subscriptionId })
      return true
    })
  } catch {
    recordEvent('billing.hetzner_traffic_observation_failed', 'warn', 'billing', { serverId: server.id, code: 'traffic_observation_failed' })
    return false
  }
}

export async function trafficCharges(tx: DbOrTx, server: Server, fx: RenewalFx) {
  if ((await cutover(tx))?.value !== true) return []
  const periods = await tx.query.hetznerTrafficPeriods.findMany({ where: t => and(eq(t.serverId, server.id),
    eq(t.providerServerId, server.providerServerId!)), orderBy: t => [desc(t.month)] })
  if (!periods[0] || utcHour(periods[0].observedAt) !== utcHour(fx.asOf)) return []
  const pending = periods.filter(period => cumulativeTrafficBlocks(period.outgoingBytes, period.includedBytes) > period.excludedBlocks + period.paidBlocks)
  if (!pending.length) return []
  if (!fx.latest || fx.asOf.getTime() - fx.latest.createdAt.getTime() >= fxMaxAgeMs('EUR')) {
    recordEvent('billing.hetzner_traffic_pricing_unavailable', 'warn', 'billing', { serverId: server.id, code: 'traffic_fx_unavailable' })
    return []
  }
  const rules = await getPricingRules(tx, 'hetzner')
  const charges = []
  for (const period of pending.reverse()) {
    const blocks = cumulativeTrafficBlocks(period.outgoingBytes, period.includedBytes) - period.excludedBlocks - period.paidBlocks
    const product = await findOfferByProductAndLocation(tx, 'hetzner', `${period.serverType}:EUR`, period.location)
    const tariff = product && hetznerTrafficTariff(product, period.location)
    const maxAge = getConfig().CATALOG_MAX_AGE_MINUTES * 60_000
    if (!product || tariff?.currency !== 'EUR' || product.lastSyncedAt > new Date() || maxAge && fx.asOf.getTime() - product.lastSyncedAt.getTime() > maxAge) {
      recordEvent('billing.hetzner_traffic_pricing_unavailable', 'warn', 'billing', { serverId: server.id, code: 'traffic_tariff_unavailable' })
      continue
    }
    try {
      const price = computePriceFromRules({ providerCurrency: 'EUR', providerAmountCents: exactProviderCents({ billingCycle: 'per-tb', amount: tariff.grossPerTb }),
        fxRate: fx.latest.rate, rules: { ...rules, markupFixedRial: 0 }, units: { numerator: blocks, denominator: blocksPerTb } })
      charges.push({ period, blocks, price, evidence: { month: period.month, serverId: server.id, subscriptionId: period.subscriptionId,
        providerServerId: period.providerServerId,
        previousOutgoingBytes: period.previousOutgoingBytes, outgoingBytes: period.outgoingBytes, includedBytes: period.includedBytes,
        firstBlock: period.excludedBlocks + period.paidBlocks + 1, lastBlock: period.excludedBlocks + period.paidBlocks + blocks,
        blocks, fxRate: fx.latest.rate, fxAt: fx.latest.createdAt.toISOString(), fxRateId: fx.latest.id, netRial: price.subtotalRial,
        taxRial: price.taxRial, totalRial: price.totalRial, serverType: period.serverType, location: period.location,
        observedAt: period.observedAt.toISOString(), grossEurPerTb: tariff.grossPerTb, catalogAt: product.lastSyncedAt.toISOString(),
        markupPercent: rules.markupPercent, taxPercent: rules.taxPercent, ruleVersion: rules.updatedAt.toISOString() } })
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      recordEvent('billing.hetzner_traffic_pricing_unavailable', 'warn', 'billing', { serverId: server.id, code: 'traffic_price_invalid' })
    }
  }
  return charges
}

type TrafficCharge = Awaited<ReturnType<typeof trafficCharges>>[number]

export async function settleTrafficCharges(tx: DbOrTx, userId: string, walletId: string, invoiceId: string, charges: TrafficCharge[]) {
  const totals = charges.reduce((total, { price }) => ({ subtotalRial: total.subtotalRial + price.subtotalRial,
    taxRial: total.taxRial + price.taxRial, totalRial: total.totalRial + price.totalRial }), { subtotalRial: 0, taxRial: 0, totalRial: 0 })
  if (!Number.isSafeInteger(totals.totalRial)) throw new ValidationError('مبلغ ترافیک خارج از محدودهٔ دفترکل است')
  for (const { period, blocks, price, evidence } of charges) {
    const description = `ترافیک مازاد هتزنر (${period.month})، ${formatTrafficTb(blocks * blockBytes)}`
    await applyWalletTransaction(tx, userId, walletId, { amountRial: price.totalRial, type: 'traffic_overage', referenceType: 'invoice',
      referenceId: invoiceId, idempotencyKey: `hetzner-traffic:${period.id}:${evidence.firstBlock}-${evidence.lastBlock}`, description, metadata: evidence })
    await tx.insert(invoiceItems).values({ invoiceId, description, quantity: 1, unitAmountRial: price.totalRial, totalRial: price.totalRial,
      referenceType: 'hetzner_traffic', referenceId: period.id })
    await tx.update(hetznerTrafficPeriods).set({ paidBlocks: period.paidBlocks + blocks, settledAt: new Date() }).where(eq(hetznerTrafficPeriods.id, period.id))
  }
  return totals
}

export async function warnTrafficFunds(tx: DbOrTx, server: Pick<Server, 'id' | 'userId' | 'hostname'>, charges: TrafficCharge[]) {
  if (!charges.length) return
  await publishNotification(tx, { userId: server.userId, eventKey: `traffic-funds:${server.id}:${charges[0]!.period.month}:${charges[0]!.evidence.firstBlock}`,
    title: 'موجودی برای ترافیک مازاد کافی نیست', body: `هزینهٔ ترافیک مازاد سرور «${server.hostname}» پس از شارژ کیف پول دوباره بررسی می‌شود.`, type: 'warning', href: '/wallet' })
}

export async function sweepStandaloneHetznerTraffic(db: DbClient, fx: RenewalFx) {
  const targets = await db.select({ server: servers, subscription: subscriptions }).from(servers)
    .innerJoin(subscriptions, eq(subscriptions.id, servers.subscriptionId))
    .where(and(eq(servers.provider, 'hetzner'), isNotNull(servers.providerServerId), isNull(servers.terminatedAt),
      inArray(servers.status, ['active', 'suspended']), inArray(subscriptions.status, ['active', 'grace', 'suspended']),
      or(eq(subscriptions.billingInterval, 'MONTHLY'), and(eq(subscriptions.billingInterval, 'HOURLY'),
        or(eq(servers.status, 'suspended'), eq(servers.billingPowerBlocked, true), eq(subscriptions.autoRenew, false))))))
  for (const { server, subscription } of targets) {
    if (!await observeHetznerTraffic(db, server, fx.asOf)) continue
    try { await settleStandalone(db, server, subscription, fx) }
    catch { recordEvent('billing.hetzner_traffic_settlement_failed', 'error', 'billing', { serverId: server.id, code: 'traffic_settlement_failed' }) }
  }
}

async function settleStandalone(db: DbClient, server: Server, subscription: Subscription, fx: RenewalFx) {
  await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).for('update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    if (!sub || !['active', 'grace', 'suspended'].includes(sub.status) || !billable(current) || current.subscriptionId !== sub.id
      || sub.billingInterval === 'HOURLY' && current.status === 'active' && !current.billingPowerBlocked && sub.autoRenew) return
    const charges = await trafficCharges(tx, current, fx)
    if (!charges.length) return
    const order = await tx.query.orders.findFirst({ where: t => eq(t.id, current.orderId), columns: { walletId: true } })
    const wallet = await getWallet(tx, current.userId, order?.walletId ?? undefined)
    try {
      await tx.transaction(async settlement => {
        const invoiceNumber = await generateNumber(settlement, 'INV', invoices, invoices.invoiceNumber)
        const now = new Date()
        const [invoice] = await settlement.insert(invoices).values({ invoiceNumber, userId: server.userId, status: 'paid',
          subtotalRial: 0, taxRial: 0, totalRial: 0, paidAt: now, issuedAt: now, dueAt: fx.asOf,
          description: `ترافیک مازاد هتزنر — ${server.hostname}`, snapshot: { traffic: charges.map(charge => charge.evidence) } }).returning({ id: invoices.id })
        const totals = await settleTrafficCharges(settlement, server.userId, wallet.id, invoice!.id, charges)
        await settlement.update(invoices).set(totals).where(eq(invoices.id, invoice!.id))
      })
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'insufficient_funds') throw error
      await warnTrafficFunds(tx, server, charges)
    }
  })
}
