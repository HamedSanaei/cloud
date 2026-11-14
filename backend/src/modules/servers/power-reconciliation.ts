import { and, eq, ne, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { providerOperations, servers, users } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { notifyServerOperation } from '../notifications/service.js'
import { customerProvider, isOrphanedPowerOperation } from './management.js'

type Operation = typeof providerOperations.$inferSelect
type Server = typeof servers.$inferSelect

export function matchesLegacyTarget(operation: Operation, server: Server) {
  const recorded = (operation.requestMetadata as { providerServerId?: string } | null)?.providerServerId
  return server.id === operation.referenceId && server.provider === operation.provider && (!recorded || recorded === server.providerServerId)
}

export async function inspectLegacyPowerOperation(server: Server, operation: Operation, actionId?: number) {
  if (!isOrphanedPowerOperation(operation) || !matchesLegacyTarget(operation, server)) {
    throw new ConflictError('این عملیات برای بررسی رسید قدیمی واجد شرایط نیست')
  }
  const provider = customerProvider(server)
  const providerServerId = server.providerServerId!
  const candidateActions = await provider.actionHistory(providerServerId, actionId)
  const view = await provider.inspect(providerServerId)
  if (view.providerServerId !== providerServerId) throw new ConflictError('شناسهٔ سرور در پاسخ ارائه‌دهنده مطابقت ندارد')
  const commands = operation.action === 'power_off' ? ['poweroff', 'stop_server'] : ['poweron', 'start_server']
  // Allow a small clock skew. The local unknown write bounds when dispatch occurred.
  const earliest = operation.createdAt.getTime() - 5_000
  const latest = operation.updatedAt.getTime() + 5_000
  const candidates = candidateActions.filter(action => commands.includes(action.command) &&
    Date.parse(action.startedAt) >= earliest && Date.parse(action.startedAt) <= latest &&
    (actionId === undefined || action.id === actionId))
  return { view, candidates }
}

export async function resolveLegacyPowerOperation(db: DbClient, server: Server, operationId: string, actorId: string,
  input: { actionId: number; note: string }) {
  const operation = await db.query.providerOperations.findFirst({ where: t => eq(t.id, operationId) })
  if (!operation || operation.referenceId !== server.id) throw new NotFoundError('عملیات سرور یافت نشد')
  const prior = (operation.responseMetadata as { operatorResolution?: { actionId: number } } | null)?.operatorResolution
  if (operation.completedAt && prior?.actionId === input.actionId) return

  const { view, candidates } = await inspectLegacyPowerOperation(server, operation, input.actionId)
  const [evidence] = candidates
  if (candidates.length !== 1 || !evidence?.finishedAt || evidence.status === 'running' ||
    (view.state !== 'active' && view.state !== 'suspended')) {
    throw new ConflictError('رسید نهایی منطبق و وضعیت پایدار سرور تأیید نشد. عملیات همچنان نیازمند بررسی است.')
  }

  await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    const [locked] = await tx.select().from(providerOperations).where(eq(providerOperations.id, operation.id)).for('update')
    const prior = (locked?.responseMetadata as { operatorResolution?: { actionId: number } } | null)?.operatorResolution
    if (locked?.completedAt && prior?.actionId === input.actionId) return
    if (!current || current.userId !== server.userId || current.terminatedAt || current.status === 'terminated' ||
      current.providerServerId !== server.providerServerId || !locked || !matchesLegacyTarget(locked, current) ||
      !isOrphanedPowerOperation(locked) || locked.attemptCount !== operation.attemptCount || locked.updatedAt.getTime() !== operation.updatedAt.getTime()) {
      throw new ConflictError('وضعیت سرور یا عملیات تغییر کرده است. بررسی را دوباره انجام دهید.')
    }
    const used = await tx.query.providerOperations.findFirst({ where: t => and(eq(t.referenceId, current.id),
      eq(t.referenceType, 'server'), ne(t.id, locked.id), sql`${t.responseMetadata}->>'actionId' = ${String(evidence.id)}`) })
    if (used) throw new ConflictError('این رسید قبلاً برای عملیات دیگری ثبت شده است')
    const result = evidence.status === 'success' ? 'succeeded' : 'failed'
    const now = new Date()
    const operatorResolution = { actionId: evidence.id, command: evidence.command, providerStatus: evidence.status,
      startedAt: evidence.startedAt, finishedAt: evidence.finishedAt, providerServerId: current.providerServerId,
      observedState: view.state, actorId, note: input.note }
    await tx.update(providerOperations).set({ status: result, completedAt: now, updatedAt: now,
      lastError: result === 'failed' ? 'provider_action_failed' : null,
      responseMetadata: { actionId: evidence.id, permanent: true, operatorResolution } }).where(eq(providerOperations.id, locked.id))
    await notifyServerOperation(tx, current, locked, result)
    await writeAudit(tx, { actorId, action: 'admin.legacy_power_operation.resolved', targetType: 'provider_operation',
      targetId: locked.id, metadata: { serverId: current.id, ...operatorResolution } })
  })
}

/**
 * Owner-initiated recovery for an old receipt-less power-off that did not
 * reach Hetzner. Requires exhaustive valid history from the original project,
 * no provider actions since the request, and the original VM still running.
 * Inconclusive provider evidence fails closed; no VM mutation is performed.
 */
export async function reconcileReceiptlessPowerOffWithoutProviderAction(
  db: DbClient, server: Server, operation: Operation, actorId: string,
): Promise<boolean> {
  if (!isOrphanedPowerOperation(operation) || operation.action !== 'power_off' ||
    !matchesLegacyTarget(operation, server) || server.terminatedAt) return false
  const now = Date.now()
  if (now - operation.createdAt.getTime() < 15 * 60_000 ||
    now - operation.updatedAt.getTime() < 5 * 60_000) return false
  const provider = customerProvider(server)
  const id = server.providerServerId!
  const history = await provider.actionHistory(id)
  if (history.length === 0 || history.length > 2_000) return false
  const cutoff = operation.createdAt.getTime() - 5_000
  if (history.some(action => Date.parse(action.startedAt) >= cutoff)) return false
  const creation = history.find(action => action.command === 'create_server' &&
    action.status === 'success' && !!action.finishedAt && Date.parse(action.startedAt) < cutoff)
  if (!creation) return false
  const view = await provider.inspect(id)
  if (view.providerServerId !== id || view.state !== 'active' || !view.ipv4 || view.ipv4 !== server.ipv4) return false
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    const [locked] = await tx.select().from(providerOperations).where(eq(providerOperations.id, operation.id)).for('update')
    if (!current || !locked || current.userId !== actorId || current.terminatedAt ||
      current.providerServerId !== id || current.ipv4 !== view.ipv4 || current.status !== 'active' ||
      current.terminationState || !isOrphanedPowerOperation(locked) || !matchesLegacyTarget(locked, current) ||
      locked.attemptCount !== operation.attemptCount ||
      locked.updatedAt.getTime() !== operation.updatedAt.getTime()) return false
    const evidence = { type: 'exhaustive_no_dispatch', provider: 'hetzner', providerServerId: id,
      serverIp: view.ipv4, observedState: view.state, matchingActionsSinceRequest: 0,
      historyCount: history.length, creationActionId: creation.id,
      latestActionAt: history.reduce((latest, action) =>
        Date.parse(action.startedAt) > Date.parse(latest) ? action.startedAt : latest, creation.startedAt),
      requestedAt: operation.createdAt.toISOString(), verifiedAt: new Date().toISOString() }
    const completedAt = new Date()
    await tx.update(providerOperations).set({ status: 'failed', completedAt, updatedAt: completedAt,
      lastError: 'No matching provider operation in verified full Hetzner server history',
      responseMetadata: { recoveryEvidence: evidence } }).where(eq(providerOperations.id, locked.id))
    await notifyServerOperation(tx, current, locked, 'failed')
    await writeAudit(tx, { actorId, action: 'server.legacy_power_off.no_dispatch_verified',
      targetType: 'provider_operation', targetId: locked.id, metadata: { serverId: current.id, ...evidence } })
    return true
  })
}
