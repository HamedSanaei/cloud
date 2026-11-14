import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { providerOperations, servers, users } from '../../db/schema.js'
import { ConflictError, InsufficientFundsError, ProviderPermanentError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { assertPowerOnFunding } from '../billing/funding.js'
import type { PrimaryIpv4 } from '../providers/customer.interface.js'
import { creditWallet } from '../wallets/service.js'
import { customerProvider } from './management.js'
import { ipv4Baseline, replacePrimaryIpv4, type IpOperation, type IpRequest, type IpServer } from './primary-ip-request.js'

type Step = 'shutdown' | 'create' | 'detach_old' | 'attach_new' | 'restart' | 'remove_old'
  | 'detach_new' | 'restore_old' | 'restart_old' | 'remove_new'
interface Progress { step?: Step; dispatching?: boolean; actionId?: number | null; ipId?: number; newIp?: string; refundId?: string }
const progressOf = (operation: IpOperation) => (operation.responseMetadata ?? {}) as Progress
function actionEvidence(request: IpRequest, progress: Progress, replacement: PrimaryIpv4 | null) {
  switch (progress.step) {
    case 'shutdown':
    case 'restart':
    case 'restart_old':
      return { target: { type: 'server' as const, id: Number(request.providerServerId.split(':')[1]) },
        command: progress.step === 'shutdown' ? 'shutdown_server' : 'start_server' }
    case 'create':
      return { target: { type: 'primary_ip' as const, id: progress.ipId ?? replacement?.id ?? 0 }, command: 'create_primary_ip' }
    case 'detach_old':
    case 'restore_old':
      return { target: { type: 'primary_ip' as const, id: request.oldIpId }, command: progress.step === 'detach_old' ? 'unassign_primary_ip' : 'assign_primary_ip' }
    case 'attach_new':
    case 'detach_new':
      return { target: { type: 'primary_ip' as const, id: progress.ipId ?? replacement?.id ?? 0 }, command: progress.step === 'detach_new' ? 'unassign_primary_ip' : 'assign_primary_ip' }
  }
}
export const primaryIpv4Result = (op: IpOperation) => {
  const request = op.requestMetadata as IpRequest, progress = progressOf(op)
  return { step: progress.step ?? null, oldIp: request.oldIp, newIp: progress.newIp ?? null,
    feeRial: request.feeRial, ledgerId: request.ledgerId, refundId: progress.refundId ?? null }
}

async function finish(db: DbClient, server: IpServer, operation: IpOperation, status: 'succeeded' | 'failed' | 'needs_reconciliation', ip?: string, operator?: { id: string; note: string }) {
  const request = operation.requestMetadata as IpRequest
  await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, request.actorId)).for('no key update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    const [locked] = await tx.select().from(providerOperations).where(eq(providerOperations.id, operation.id)).for('update')
    if (!locked || locked.completedAt || locked.attemptCount !== operation.attemptCount ||
      (operator && locked.status !== 'needs_reconciliation')) {
      if (operator) throw new ConflictError('وضعیت عملیات در حین بررسی تغییر کرد.')
      return
    }
    const progress = progressOf(locked)
    if (status === 'needs_reconciliation' && locked.status === status && progress.refundId) return
    progress.dispatching = false
    if (status === 'succeeded') {
      if (!ip || current?.providerServerId !== request.providerServerId || current.userId !== request.actorId || current.terminatedAt) return
      await tx.update(servers).set({ ipv4: ip, status: request.wasRunning ? 'active' : 'suspended', lastSyncedAt: new Date() }).where(eq(servers.id, server.id))
    } else if (!progress.refundId) {
      const refund = await creditWallet(tx, request.actorId, request.walletId, request.feeRial, { type: 'refund',
        referenceType: 'primary_ipv4_replacement', referenceId: server.id, idempotencyKey: `primary-ipv4:${operation.id}:refund`,
        description: `بازگشت مبلغ تعویض IPv4 اصلی — ${server.hostname}`, metadata: { operationId: operation.id, debitId: request.ledgerId } })
      progress.refundId = refund.transaction.id
    }
    const now = new Date()
    await tx.update(providerOperations).set({ status, responseMetadata: progress, updatedAt: now,
      completedAt: status === 'needs_reconciliation' ? null : now }).where(eq(providerOperations.id, locked.id))
    await writeAudit(tx, { actorId: operator?.id ?? request.actorId, action: `server.primary_ipv4.${status}`, targetType: 'server', targetId: server.id,
      metadata: { operationId: locked.id, oldIp: request.oldIp, newIp: ip, step: progress.step, ledgerId: request.ledgerId, refundId: progress.refundId, note: operator?.note } })
  })
}

export async function advancePrimaryIpv4(db: DbClient, server: IpServer, operation: IpOperation) {
  if (operation.action !== replacePrimaryIpv4 || operation.completedAt) return
  const request = operation.requestMetadata as IpRequest
  const progress = progressOf(operation)
  const serverIdentity = request.providerServerId
  const serverId = serverIdentity.split(':')[1]!
  const stale = Date.now() - operation.updatedAt.getTime() > 120_000
  const finishHere = (status: 'failed' | 'succeeded' | 'needs_reconciliation', ip?: string) => finish(db, server, operation, status, ip)
  const review = () => finishHere('needs_reconciliation')
  const wait = () => stale ? review() : undefined
  if (server.providerServerId !== serverIdentity || server.userId !== request.actorId || server.provider !== operation.provider || server.terminatedAt) return review()
  if (progress.dispatching) return wait()

  try {
    const manager = customerProvider(server), api = manager.primaryIpv4
    if (!api) return review()
    const view = await manager.inspect(serverIdentity)
    if (view.providerServerId !== serverIdentity || view.metadata?.location !== request.location) return review()
    if (view.state !== 'active' && view.state !== 'suspended') return wait()
    const off = view.state === 'suspended'
    const currentIpId = view.metadata?.primaryIpv4Id
    const old = await api.read(serverIdentity, request.oldIpId)
    const matchesOld = old?.serverId === serverId && currentIpId === old.id && view.ipv4 === old.address && old.address === request.oldIp
    const step = progress.step

    // Claim the next step before its mutation. A crash or lost response can
    // only advance from provider evidence. This step is never dispatched again.
    async function dispatch(next: Step, send: () => Promise<{ actionId: number | null; ipId?: number }>, replacement?: PrimaryIpv4) {
      const [claimed] = await db.update(providerOperations).set({ status: 'running', attemptCount: operation.attemptCount + 1,
        responseMetadata: sql`coalesce(${providerOperations.responseMetadata}, '{}'::jsonb) || ${JSON.stringify({ step: next, dispatching: true, actionId: null,
          ...(replacement ? { ipId: replacement.id, newIp: replacement.address } : {}) })}::jsonb`, updatedAt: new Date() })
        .where(and(eq(providerOperations.id, operation.id), isNull(providerOperations.completedAt), eq(providerOperations.attemptCount, operation.attemptCount))).returning()
      if (!claimed) return
      try {
        const receipt = await send()
        await db.update(providerOperations).set({ responseMetadata: sql`${providerOperations.responseMetadata} || ${JSON.stringify({ ...receipt, dispatching: false })}::jsonb` })
          .where(and(eq(providerOperations.id, operation.id), isNull(providerOperations.completedAt), eq(providerOperations.attemptCount, claimed.attemptCount)))
      } catch (error) {
        // A definite rejection is eligible for compensation. An ambiguous
        // outcome returns the fee and waits for exact resource evidence.
        if (error instanceof ProviderPermanentError || error instanceof InsufficientFundsError) {
          await db.update(providerOperations).set({ responseMetadata: sql`${providerOperations.responseMetadata} || '{"actionId":0,"dispatching":false}'::jsonb` })
            .where(and(eq(providerOperations.id, operation.id), isNull(providerOperations.completedAt), eq(providerOperations.attemptCount, claimed.attemptCount)))
        } else await finish(db, server, claimed, 'needs_reconciliation')
      }
    }
    const run = (next: Step, send: () => Promise<number>, replacement?: PrimaryIpv4) => dispatch(next, async () => ({ actionId: await send() }), replacement)
    const remove = (next: 'remove_old' | 'remove_new', ip: PrimaryIpv4) => dispatch(next, async () => {
      await api.remove(serverIdentity, ip.id)
      return { actionId: null }
    })
    const create = () => dispatch('create', () => api.create(serverIdentity, request.location, operation.id))
    const power = (next: 'shutdown' | 'restart' | 'restart_old', action: 'shutdown' | 'power_on') => run(next, async () => {
      if (action === 'power_on') await assertPowerOnFunding(db, server)
      return (await manager.submit(serverIdentity, action, {})).actionId
    })

    if (!step) {
      if (operation.status !== 'pending') return review()
      if (!await ipv4Baseline(server, view) || !matchesOld || (request.wasRunning === off)) return finishHere('failed')
      return off ? create() : power('shutdown', 'shutdown')
    }

    const replacement = step === 'shutdown' ? null : await api.findReplacement(serverIdentity, operation.id)
    if (replacement && (replacement.location !== request.location || replacement.id === request.oldIpId ||
      replacement.address === request.oldIp || (progress.ipId !== undefined && progress.ipId !== replacement.id) ||
      (replacement.serverId !== null && replacement.serverId !== serverId) || !replacement.autoDelete || replacement.protected || replacement.blocked)) return review()
    if (old && (old.location !== request.location || old.address !== request.oldIp ||
      (old.serverId !== null && old.serverId !== serverId) || !old.autoDelete || old.protected || old.blocked || old.customReverseDns)) return review()
    const matchesNew = replacement?.serverId === serverId && currentIpId === replacement.id && view.ipv4 === replacement.address
    const noAssignment = (currentIpId === undefined || currentIpId === 0) && !view.ipv4
    const restoredPower = request.wasRunning ? !off : off

    let receipt: 'running' | 'success' | 'error' | undefined
    if (progress.actionId === 0) receipt = 'error'
    else if (progress.actionId) {
      const expected = actionEvidence(request, progress, replacement)
      if (!expected?.target.id) return wait()
      receipt = await api.observe(serverIdentity, progress.actionId, expected.target, expected.command)
      if (receipt === 'running') return wait()
    }

    // A lost create/assign receipt can be recovered from the exact tagged
    // resource or matching assignment. Other ambiguous steps need evidence
    // of the resulting state before any subsequent mutation can proceed.

    const restore = async () => {
      if (!off || !noAssignment || old?.serverId !== null) return review()
      return run('restore_old', () => api.assign(serverIdentity, request.oldIpId))
    }
    async function cleanUpReplacement() {
      if (!matchesOld) return review()
      if (!restoredPower) return off ? power('restart_old', 'power_on') : review()
      if (!replacement) return finishHere('failed')
      if (replacement.serverId !== null) return review()
      return remove('remove_new', replacement)
    }
    async function cleanUpOld() {
      if (!matchesNew || !restoredPower) return review()
      if (!old) return finishHere('succeeded', replacement.address)
      if (old.serverId !== null) return review()
      return remove('remove_old', old)
    }

    switch (step) {
      case 'shutdown':
        if (off && matchesOld) return create()
        if (receipt === 'error' && matchesOld && !off) return finishHere('failed')
        return wait()
      case 'create':
        if (receipt === 'error') return cleanUpReplacement()
        if (replacement?.serverId === null && off && matchesOld) return run('detach_old', () => api.unassign(serverIdentity, old.id), replacement)
        return wait()
      case 'detach_old':
        if (receipt === 'error' && matchesOld && replacement?.serverId === null) return cleanUpReplacement()
        if (off && old?.serverId === null && noAssignment && replacement?.serverId === null) {
          return run('attach_new', () => api.assign(serverIdentity, replacement.id), replacement)
        }
        return wait()
      case 'attach_new':
        if (matchesNew && off && old?.serverId === null) return request.wasRunning ? power('restart', 'power_on') : cleanUpOld()
        if (receipt === 'error' && replacement?.serverId === null) return restore()
        return wait()
      case 'restart':
        if (matchesNew && restoredPower) return cleanUpOld()
        if (receipt === 'error' && matchesNew && off && old?.serverId === null) return run('detach_new', () => api.unassign(serverIdentity, replacement.id), replacement)
        return wait()
      case 'detach_new':
        if (replacement?.serverId === null && noAssignment) return restore()
        return wait()
      case 'restore_old':
        if (matchesOld) return cleanUpReplacement()
        return wait()
      case 'restart_old':
        if (matchesOld && restoredPower) return cleanUpReplacement()
        return wait()
      case 'remove_old':
        if (!old && matchesNew && restoredPower) return finishHere('succeeded', replacement.address)
        return wait()
      case 'remove_new':
        if (!replacement && matchesOld && restoredPower) return finishHere('failed')
        return wait()
    }
  } catch {
    // Provider read failures cannot prove non-dispatch or a failed rollback.
    await wait()
  }
}

/** An operator has inspected the project action history and restored the original state. */
export async function confirmPrimaryIpv4Rollback(db: DbClient, server: IpServer, operation: IpOperation, operator: { id: string; note: string }) {
  if (operation.action !== replacePrimaryIpv4 || operation.status !== 'needs_reconciliation' || operation.completedAt ||
    operation.referenceId !== server.id || server.terminatedAt || Date.now() - operation.updatedAt.getTime() < 120_000) {
    throw new ConflictError('بازگردانی هنوز قابل تأیید نیست.')
  }
  const request = operation.requestMetadata as IpRequest
  if (server.userId !== request.actorId || server.providerServerId !== request.providerServerId || server.provider !== operation.provider) {
    throw new ConflictError('مالکیت سرور با درخواست ثبت‌شده مطابقت ندارد.')
  }
  const manager = customerProvider(server)
  const [view, replacement] = await Promise.all([manager.inspect(request.providerServerId), manager.primaryIpv4?.findReplacement(request.providerServerId, operation.id)])
  const pendingAction = progressOf(operation).actionId
  if (pendingAction) {
    const progress = progressOf(operation)
    const expected = actionEvidence(request, progress, replacement ?? null)
    if (!expected || !manager.primaryIpv4 || await manager.primaryIpv4.observe(request.providerServerId, pendingAction, expected.target, expected.command) === 'running') {
      throw new ConflictError('عملیات هتزنر هنوز نهایی نشده است.')
    }
  }
  const baseline = await ipv4Baseline(server, view)
  if (!baseline || baseline.oldIpId !== request.oldIpId || baseline.oldIp !== request.oldIp || baseline.wasRunning !== request.wasRunning ||
    replacement !== null) throw new ConflictError('آدرس، برق یا پاک‌سازی منبع جدید هنوز مطابق وضعیت اولیه نیست.')
  await finish(db, server, operation, 'failed', undefined, operator)
}
