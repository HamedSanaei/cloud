import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { orders, servers } from '../../db/schema.js'
import { serverToDto } from '../../lib/dto.js'
import { NotFoundError } from '../../lib/errors.js'
import { provisionState, type ServerTracking } from '../../contracts/server-lifecycle.js'
import { loadFundingFleet, serverPowerPolicy } from '../billing/funding.js'

export async function provisioningRow(db: DbClient, userId: string, orderId: string) {
  const order = await db.query.orders.findFirst({ where: t => and(eq(t.id, orderId), eq(t.userId, userId)) })
  if (!order) throw new NotFoundError('درخواست ساخت یافت نشد')
  const [server, operation] = await Promise.all([
    db.query.servers.findFirst({ where: t => and(eq(t.orderId, order.id), eq(t.userId, userId)) }),
    db.query.providerOperations.findFirst({ where: t => and(eq(t.kind, 'provision'), eq(t.referenceId, order.id)), orderBy: t => desc(t.createdAt) }),
  ])
  // A completed create call is not readiness. Only provider-observed activation is.
  const state = server?.terminatedAt ? 'cancelled' : server?.activatedAt ? 'ready' : provisionState(order.status === 'active' ? 'provisioning' : order.status, operation?.status)
  const tracking: ServerTracking = { source: 'site', reference: order.id, orderId: order.id, serverId: server?.id ?? null,
    operationId: operation?.id ?? null, state, createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString() }
  if (server) return { ...serverToDto(server, serverPowerPolicy(server, await loadFundingFleet(db, userId))), tracking }
  return { id: `order:${order.id}`, name: order.hostname, status: 'building' as const, lifecycle: state, provider: order.provider,
    datacenter: order.providerLocation, serverType: order.providerProductId, os: order.operatingSystem,
    billingInterval: order.billingInterval, cpu: '', ram: '', disk: '', createdAt: order.createdAt.toISOString(), tracking,
    power: { canPowerOn: false, canPowerOff: false, canReboot: false, billingBlocked: false, requiredBalanceToman: null, pendingAction: null } }
}

export async function pendingProvisioningRows(db: DbClient, userId: string, limit = 50) {
  const rows = await db.select({ id: orders.id }).from(orders).leftJoin(servers, eq(servers.orderId, orders.id))
    .where(and(eq(orders.userId, userId), isNull(servers.id), inArray(orders.status, ['paid', 'queued', 'provisioning', 'requires_review', 'failed', 'cancelled', 'refunded'])))
    .orderBy(desc(orders.createdAt)).limit(limit)
  return Promise.all(rows.map(row => provisioningRow(db, userId, row.id)))
}
