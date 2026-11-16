import { and, eq, inArray, isNull, lte } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { orders, servers, serviceIncidents, subscriptions } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { enqueueSms } from './sms.js'

export const smsDate = (date: Date) => date.toLocaleDateString('fa-IR', { timeZone: 'UTC' })
export const smsToman = (rial: number) => String(rial / 10)

/** Manual incident report is authoritative, explicit and audited; not inferred from timeouts. */
export async function changeIncident(db: DbClient, actorId: string, serverId: string, note: string, resolve: boolean) {
  return db.transaction(async tx => {
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update')
    if (!server) throw new NotFoundError('سرور یافت نشد')
    const [open] = await tx.select().from(serviceIncidents).where(and(eq(serviceIncidents.serverId, serverId), isNull(serviceIncidents.resolvedAt)))
    if (resolve && !open) throw new NotFoundError('اختلال باز برای این سرور وجود ندارد')
    if (!resolve && open) return open
    const [incident] = resolve
      ? await tx.update(serviceIncidents).set({ resolvedAt: new Date() }).where(eq(serviceIncidents.id, open!.id)).returning()
      : await tx.insert(serviceIncidents).values({ serverId, openedBy: actorId, note }).returning()
    await enqueueSms(tx, resolve ? 'incidentResolved' : 'incidentDetected', server.userId, `incident:${incident!.id}:${resolve ? 'resolved' : 'opened'}`, { serviceName: server.hostname })
    await writeAudit(tx, { actorId, action: resolve ? 'service.incident_resolved' : 'service.incident_detected', targetType: 'server', targetId: serverId, metadata: { incidentId: incident!.id } })
    return incident
  })
}
/** Called after provider-confirmed state persists in the caller's transaction. */
export async function confirmedNoCreditStop(db: DbOrTx, server: typeof servers.$inferSelect, stopped: boolean) {
  if (stopped && server.billingPowerBlocked && server.billingPowerBlockedAt) {
    await enqueueSms(db, 'serverStoppedNoCredit', server.userId, `server:${server.id}:no-credit:${server.billingPowerBlockedAt.toISOString()}`, { serviceName: server.hostname })
  }
}
export async function sweepSmsEvents(db: DbClient, now = new Date()) {
  await db.transaction(async tx => {
    // Delay means still pending after 15 minutes, not provisioning failure/success.
    const delayed = await tx.select().from(orders).where(and(inArray(orders.status, ['paid', 'queued', 'provisioning']), lte(orders.paidAt, new Date(now.getTime() - 15 * 60000)))).for('share')
    for (const order of delayed) await enqueueSms(tx, 'provisioningDelayed', order.userId, `order:${order.id}:provisioning-delay`, { orderNumber: order.orderNumber })
    const expiring = await tx.select({ sub: subscriptions, hostname: servers.hostname }).from(subscriptions).innerJoin(servers, eq(subscriptions.serverId, servers.id))
      .where(and(eq(subscriptions.status, 'active'), inArray(subscriptions.billingInterval, ['DAILY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']),
        lte(subscriptions.currentPeriodEnd, new Date(now.getTime() + 24 * 3600000)), isNull(servers.terminatedAt)))
    for (const { sub, hostname } of expiring) {
      if (sub.currentPeriodEnd <= now) continue
      await enqueueSms(tx, 'serviceExpiring', sub.userId, `subscription:${sub.id}:expiry:${sub.currentPeriodEnd.toISOString()}`, { serviceName: hostname, endDate: smsDate(sub.currentPeriodEnd) })
    }
  })
}
