import { eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { providerOperations, servers } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { getProvider } from '../providers/registry.js'
import type { ProviderServerView } from '../providers/provider.interface.js'

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

export async function activateServer(db: DbClient, serverId: string, view?: ProviderServerView) {
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

export async function updateServerFromView(db: DbClient, serverId: string, view: ProviderServerView) {
  const update: Record<string, unknown> = { lastSyncedAt: new Date() }
  if (view.state === 'active' && view.ipv4) update.ipv4 = view.ipv4
  if (view.state === 'active' && view.ipv6) update.ipv6 = view.ipv6
  if (view.hostname) update.hostname = view.hostname
  if (view.trafficUsedGb !== undefined) update.trafficUsedGb = view.trafficUsedGb
  if (view.metadata) update.providerMetadata = view.metadata as never
  if (view.state === 'suspended') update.status = 'suspended'
  if (view.state === 'terminated') update.status = 'terminated'
  if (view.state === 'active') update.status = 'active'
  await db.update(servers).set(update).where(eq(servers.id, serverId))
}

/**
 * Provider-backed server action (power-on/off/reboot). The caller (route) is
 * responsible for enqueueing the job; this creates the provider operation
 * record BEFORE the provider is contacted (idempotency + audit trail).
 */
export async function createServerActionOperation(db: DbClient, serverId: string, action: 'power_on' | 'power_off' | 'reboot') {
  const server = await db.query.servers.findFirst({ where: (t) => eq(t.id, serverId) })
  if (!server) throw new NotFoundError('سرور یافت نشد')
  if (!server.providerServerId) throw new ConflictError('سرور هنوز در سرویس‌دهنده ثبت نشده است')
  const provider = getProvider(server.provider)
  provider.require(action)

  const businessKey = `leaseweb:${action}:server:${server.id}`
  const existing = await db.query.providerOperations.findFirst({ where: (t) => eq(t.businessKey, businessKey) })
  if (existing) {
    if (existing.status === 'succeeded') return existing
    if (existing.status === 'running' || existing.status === 'pending') return existing // another worker is on it
    // failed/unknown => allow a new attempt
  }

  const [op] = await db
    .insert(providerOperations)
    .values({
      provider: server.provider,
      kind: 'server_action',
      action,
      referenceType: 'server',
      referenceId: server.id,
      businessKey,
      status: 'pending',
      requestMetadata: { providerServerId: server.providerServerId },
    })
    .onConflictDoNothing()
    .returning()
  return op ?? (await db.query.providerOperations.findFirst({ where: (t) => eq(t.businessKey, businessKey) }))
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