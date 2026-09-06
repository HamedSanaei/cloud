import { eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { subscriptionEvents, subscriptions } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { getConfig } from '../../config.js'
import { writeAudit } from '../audit/service.js'

export type SubscriptionStatus = 'active' | 'grace' | 'suspended' | 'cancelled' | 'expired'

export interface CreateSubscriptionInput {
  userId: string
  serverId: string
  orderId: string
  priceRial: number
  billingInterval?: 'MONTHLY'
  periodStart?: Date
}

export async function createSubscription(db: DbClient, input: CreateSubscriptionInput) {
  const start = input.periodStart ?? new Date()
  const end = addInterval(start, input.billingInterval ?? 'MONTHLY')
  const [sub] = await db
    .insert(subscriptions)
    .values({
      userId: input.userId,
      serverId: input.serverId,
      orderId: input.orderId,
      billingInterval: input.billingInterval ?? 'MONTHLY',
      priceRial: input.priceRial,
      status: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      nextInvoiceAt: end,
      nextDueAt: end,
    })
    .returning()
  if (!sub) throw new Error('failed to create subscription')
  await db.insert(subscriptionEvents).values({
    subscriptionId: sub.id,
    event: 'created',
    metadata: { priceRial: input.priceRial, periodEnd: end.toISOString() },
  })
  await writeAudit(db, {
    actorId: input.userId,
    action: 'subscription.created',
    targetType: 'subscription',
    targetId: sub.id,
    metadata: { serverId: input.serverId, priceRial: input.priceRial },
  })
  return sub
}

export async function listSubscriptions(db: DbClient, userId: string) {
  return db.query.subscriptions.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  })
}

export async function getSubscription(db: DbClient, userId: string, subscriptionId: string) {
  const sub = await db.query.subscriptions.findFirst({ where: (t) => eq(t.id, subscriptionId) })
  if (!sub || sub.userId !== userId) throw new NotFoundError('اشتراک یافت نشد')
  return sub
}

export async function setAutoRenew(db: DbClient, userId: string, subscriptionId: string, autoRenew: boolean) {
  const sub = await getSubscription(db, userId, subscriptionId)
  await db.update(subscriptions).set({ autoRenew }).where(eq(subscriptions.id, sub.id))
  await db.insert(subscriptionEvents).values({
    subscriptionId: sub.id,
    event: autoRenew ? 'auto_renew_enabled' : 'auto_renew_disabled',
  })
  return sub
}

export async function cancelSubscription(db: DbClient, userId: string, subscriptionId: string) {
  const sub = await getSubscription(db, userId, subscriptionId)
  if (sub.status === 'cancelled') return sub
  await db.update(subscriptions).set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, sub.id))
  await db.insert(subscriptionEvents).values({ subscriptionId: sub.id, event: 'cancelled' })
  await writeAudit(db, {
    actorId: userId,
    action: 'subscription.cancelled',
    targetType: 'subscription',
    targetId: sub.id,
  })
  return sub
}

/**
 * Extend the subscription periods by one interval. Called by the renewal job
 * after a successful payment. Idempotent: if already extended past `now`, no-op.
 */
export async function extendSubscriptionPeriod(db: DbClient, subscriptionId: string): Promise<boolean> {
  const sub = await db.query.subscriptions.findFirst({ where: (t) => eq(t.id, subscriptionId) })
  if (!sub) return false
  if (sub.currentPeriodEnd > new Date() && sub.status === 'active') return false

  const start = sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date()
  const end = addInterval(start, sub.billingInterval)
  await db.update(subscriptions).set({
    currentPeriodStart: start,
    currentPeriodEnd: end,
    nextInvoiceAt: end,
    nextDueAt: end,
    status: 'active',
    graceUntil: null,
    updatedAt: new Date(),
  }).where(eq(subscriptions.id, sub.id))
  await db.insert(subscriptionEvents).values({
    subscriptionId: sub.id,
    event: 'renewed',
    metadata: { periodStart: start.toISOString(), periodEnd: end.toISOString() },
  })
  await writeAudit(db, {
    action: 'subscription.renewed',
    targetType: 'subscription',
    targetId: sub.id,
    metadata: { periodEnd: end.toISOString() },
  })
  return true
}

export async function enterGracePeriod(db: DbClient, subscriptionId: string): Promise<void> {
  const graceUntil = new Date(Date.now() + getConfig().RENEWAL_GRACE_DAYS * 24 * 60 * 60 * 1000)
  await db.update(subscriptions).set({ status: 'grace', graceUntil, updatedAt: new Date() }).where(eq(subscriptions.id, subscriptionId))
  await db.insert(subscriptionEvents).values({
    subscriptionId,
    event: 'grace_started',
    metadata: { graceUntil: graceUntil.toISOString() },
  })
}

export async function suspendSubscription(db: DbClient, subscriptionId: string): Promise<void> {
  await db.update(subscriptions).set({ status: 'suspended', updatedAt: new Date() }).where(eq(subscriptions.id, subscriptionId))
  await db.insert(subscriptionEvents).values({ subscriptionId, event: 'suspended' })
  await writeAudit(db, { action: 'subscription.suspended', targetType: 'subscription', targetId: subscriptionId })
}

/** Subscriptions that need a renewal invoice (active or in grace, invoice due within horizon). */
export async function findSubscriptionsDueForRenewal(db: DbClient, horizonMs: number) {
  return db.query.subscriptions.findMany({
    where: (t, { and: _and, inArray, lte }) =>
      _and(
        inArray(t.status, ['active', 'grace']),
        lte(t.nextInvoiceAt, new Date(Date.now() + horizonMs)),
      ),
    orderBy: (t, { asc }) => [asc(t.nextInvoiceAt)],
  })
}

export async function findGraceExpiredSubscriptions(db: DbClient) {
  return db.query.subscriptions.findMany({
    where: (t, { and: _and, eq: _eq, lt }) => _and(_eq(t.status, 'grace'), lt(t.graceUntil ?? new Date(0), new Date())),
    orderBy: (t, { asc }) => [asc(t.graceUntil ?? new Date(0))],
  })
}

function addInterval(date: Date, interval: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL'): Date {
  const out = new Date(date)
  switch (interval) {
    case 'QUARTERLY':
      out.setUTCMonth(out.getUTCMonth() + 3)
      break
    case 'SEMIANNUAL':
      out.setUTCMonth(out.getUTCMonth() + 6)
      break
    case 'ANNUAL':
      out.setUTCMonth(out.getUTCMonth() + 12)
      break
    default:
      out.setUTCMonth(out.getUTCMonth() + 1)
  }
  return out
}