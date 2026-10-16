import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { providerOperations, servers, subscriptions, users } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { getProvider } from '../providers/registry.js'
import type { ProviderServerView } from '../providers/provider.interface.js'
import { assertPowerOnFunding, loadFundingFleet, serverPowerPolicy } from '../billing/funding.js'

export interface CreateServerRecordInput {
  userId: string
  orderId: string
  provider: string
  providerOrderId?: string
  providerServerId?: string
  providerProductId: string
  providerLocation: string
  hostname: string
  operatingSystem: string
  vcpu: number
  memoryMb: number
  diskGb: number
  trafficLimitGb?: number | null
}

export async function createServerRecord(db: DbClient, input: CreateServerRecordInput) {
  const [server] = await db
    .insert(servers)
    .values({
      userId: input.userId,
      orderId: input.orderId,
      provider: input.provider,
      providerOrderId: input.providerOrderId ?? null,
      providerServerId: input.providerServerId ?? null,
      providerProductId: input.providerProductId,
      providerLocation: input.providerLocation,
      hostname: input.hostname,
      status: 'provisioning',
      operatingSystem: input.operatingSystem,
      vcpu: input.vcpu,
      memoryMb: input.memoryMb,
      diskGb: input.diskGb,
      trafficLimitGb: input.trafficLimitGb ?? null,
    })
    .returning()
  if (!server) throw new Error('failed to create server record')
  return server
}

export async function getServerForUser(db: DbClient, userId: string, serverId: string) {
  const server = await db.query.servers.findFirst({ where: (t) => eq(t.id, serverId) })
  if (!server || server.userId !== userId) throw new NotFoundError('سرور یافت نشد')
  return server
}

export async function listServersForUser(db: DbClient, userId: string, opts: { limit?: number; offset?: number } = {}) {
  return db.query.servers.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  })
}

export async function activateServer(db: DbOrTx, serverId: string, view?: ProviderServerView) {
  const now = new Date()
  const update: Record<string, unknown> = { status: 'active', activatedAt: now, lastSyncedAt: now }
  if (view?.ipv4) update.ipv4 = view.ipv4
  if (view?.ipv6) update.ipv6 = view.ipv6
  if (view?.hostname) update.hostname = view.hostname
  if (view?.trafficUsedGb !== undefined) update.trafficUsedGb = view.trafficUsedGb
  if (view?.metadata) update.providerMetadata = view.metadata as never
  await db.update(servers).set(update).where(eq(servers.id, serverId))
}

export async function failServer(db: DbClient, serverId: string, error: string) {
  await db.update(servers).set({ status: 'failed', providerMetadata: { error } as never, lastSyncedAt: new Date() }).where(eq(servers.id, serverId))
}

export async function updateServerFromView(db: DbOrTx, serverId: string, view: ProviderServerView) {
  const owner = await db.query.servers.findFirst({ where: (t) => eq(t.id, serverId) })
  if (!owner) return
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('no key update')
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update')
    if (!server) return
    const update: Partial<typeof servers.$inferInsert> = { lastSyncedAt: new Date() }
    if (view.state === 'active' && view.ipv4) update.ipv4 = view.ipv4
    if (view.state === 'active' && view.ipv6) update.ipv6 = view.ipv6
    if (view.hostname) update.hostname = view.hostname
    if (view.trafficUsedGb !== undefined) update.trafficUsedGb = view.trafficUsedGb
    if (view.metadata) update.providerMetadata = view.metadata
    if (view.state === 'suspended' || view.state === 'terminated' || view.state === 'active') update.status = view.state
    let billingBlocked = server.billingPowerBlocked
    if (view.state === 'active' && billingBlocked) {
      billingBlocked = serverPowerPolicy(server, await loadFundingFleet(tx, server.userId)).billingBlocked
      if (!billingBlocked) {
        update.billingPowerBlocked = false
        update.billingPowerBlockedAt = null
      }
    }
    await tx.update(servers).set(update).where(eq(servers.id, serverId))
    if (server.subscriptionId && (view.state === 'suspended' || (view.state === 'active' && !billingBlocked))) {
      // Hourly subscriptions do not keep charging while the provider proves the server is off.
      await tx.update(subscriptions).set({ status: view.state === 'active' ? 'active' : 'suspended', updatedAt: new Date() }).where(and(
        eq(subscriptions.id, server.subscriptionId),
        eq(subscriptions.billingInterval, 'HOURLY'),
        inArray(subscriptions.status, ['active', 'grace', 'suspended']),
      ))
    }
  })
}

/**
 * Provider-backed server action (power-on/off/reboot). The caller (route) is
 * responsible for enqueueing the job; this creates the provider operation
 * record BEFORE the provider is contacted (idempotency + audit trail).
 */
export async function createServerActionOperation(
  db: DbOrTx,
  serverId: string,
  action: 'power_on' | 'power_off' | 'reboot',
  opts: { businessKey?: string; reason?: 'low_balance' } = {},
) {
  const owner = await db.query.servers.findFirst({ where: (t) => eq(t.id, serverId) })
  if (!owner) throw new NotFoundError('سرور یافت نشد')
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('no key update')
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update')
    if (!server?.providerServerId) throw new ConflictError('سرور هنوز در سرویس‌دهنده ثبت نشده است')
    if (server.status !== 'active' && server.status !== 'suspended') throw new ConflictError('وضعیت سرور برای عملیات برق مناسب نیست')
    if (action === 'power_on' && server.status !== 'suspended') throw new ConflictError('فقط سرور خاموش را می‌توان روشن کرد')
    if (action === 'reboot' && server.status !== 'active') throw new ConflictError('فقط سرور روشن را می‌توان راه‌اندازی مجدد کرد')
    getProvider(server.provider).require(action)
    if (action === 'power_on' || action === 'reboot') await assertPowerOnFunding(tx, server)
    const pending = await tx.query.providerOperations.findFirst({
      where: (t) => and(eq(t.kind, 'server_action'), eq(t.referenceId, server.id), inArray(t.status, ['pending', 'running', 'unknown'])),
    })
    if (pending) {
      if (pending.action !== action || pending.status === 'unknown') throw new ConflictError('عملیات قبلی سرور هنوز نهایی نشده است')
      return pending
    }
    const businessKey = opts.businessKey ?? `${server.provider}:${action}:server:${server.id}:${randomUUID()}`
    const existing = await tx.query.providerOperations.findFirst({ where: (t) => eq(t.businessKey, businessKey) })
    if (existing) return existing
    const [operation] = await tx.insert(providerOperations).values({
      provider: server.provider,
      kind: 'server_action',
      action,
      referenceType: 'server',
      referenceId: server.id,
      businessKey,
      status: 'pending',
      requestMetadata: { providerServerId: server.providerServerId, reason: opts.reason },
    }).returning()
    if (!operation) throw new Error('failed to create server action operation')
    return operation
  })
}

export async function recordServerActionAudit(db: DbClient, userId: string, serverId: string, action: string, ok: boolean) {
  await writeAudit(db, {
    actorId: userId,
    action: `server.${action}`,
    targetType: 'server',
    targetId: serverId,
    metadata: { ok },
  })
}

export async function countActiveServers(db: DbClient, userId: string): Promise<number> {
  const rows = await db.query.servers.findMany({ where: (t) => eq(t.userId, userId) })
  return rows.filter((s) => s.status === 'active').length
}