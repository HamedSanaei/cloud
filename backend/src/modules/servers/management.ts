import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { invoices, providerOperations, renewalAttempts, servers, serverSecrets, subscriptionEvents, subscriptions, users } from '../../db/schema.js'
import { AppError, ConflictError, ForbiddenError, InsufficientFundsError, NotFoundError, ProviderPermanentError, ProviderUnknownError, ValidationError } from '../../lib/errors.js'
import type { SessionUser } from '../auth/service.js'
import type { ProviderServerView } from '../providers/provider.interface.js'
import { writeAudit } from '../audit/service.js'
import { assertPowerOnFunding } from '../billing/funding.js'
import { getProvider } from '../providers/registry.js'
import { managementActions, type ManagementAction } from '../providers/customer.interface.js'
import { hetznerCommands } from '../providers/hetzner/customer.js'
import { getServerForUser, updateServerFromView } from './service.js'
import { sealServerSecret } from './secrets.js'
import { notifyServerOperation } from '../notifications/service.js'

const unresolved = ['pending', 'running', 'unknown', 'needs_reconciliation'] as const
const reconcilable = ['running', 'unknown', 'needs_reconciliation'] as const
type Operation = typeof providerOperations.$inferSelect
type Server = typeof servers.$inferSelect
const operationTimeoutMs = 2 * 60 * 1000

export function operationDelayed(op: Operation) {
  return !op.completedAt && Date.now() - op.createdAt.getTime() >= operationTimeoutMs
}

export async function notifyDelayedOperations(db: DbClient, server: Server) {
  const operations = await db.query.providerOperations.findMany({ where: t => and(eq(t.referenceId, server.id),
    inArray(t.kind, ['server_action', 'server_management']), inArray(t.status, [...unresolved]), isNull(t.completedAt)) })
  for (const op of operations) {
    if (op.status === 'unknown' || op.status === 'needs_reconciliation' || operationDelayed(op)) {
      await db.transaction(async tx => {
        const [current] = await tx.select().from(providerOperations).where(and(eq(providerOperations.id, op.id),
          inArray(providerOperations.status, [...unresolved]), isNull(providerOperations.completedAt))).for('update')
        if (current) await notifyServerOperation(tx, server, current, 'unknown')
      })
    }
  }
}

export async function recordOperationFailure(db: DbOrTx, server: Server, operation: Operation,
  lastError: string, result: 'failed' | 'unknown', from: Array<Operation['status']>) {
  await db.transaction(async tx => {
    const now = new Date()
    if (operation.action === 'delete') await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, server.id)).for('update')
    const [changed] = await tx.update(providerOperations).set({ status: result, lastError, updatedAt: now,
      completedAt: result === 'failed' ? now : null }).where(and(eq(providerOperations.id, operation.id),
      isNull(providerOperations.completedAt), inArray(providerOperations.status, from))).returning({ id: providerOperations.id })
    if (!changed) return
    if (operation.action === 'delete') await tx.update(servers).set({ terminationState: result === 'failed' ? 'delete_failed' : 'outcome_unknown' }).where(eq(servers.id, server.id))
    await notifyServerOperation(tx, server, operation, result)
  })
}
export function customerProvider(server: Server) {
  const manager = getProvider(server.provider).customer
  if (!manager || server.provider !== 'hetzner') throw new ValidationError('مدیریت این قابلیت برای ارائه‌دهندهٔ سرور پشتیبانی نمی‌شود')
  if (!server.providerServerId || !/^[a-z0-9][a-z0-9_-]{0,62}:[1-9]\d*$/.test(server.providerServerId)) throw new ConflictError('پروژهٔ مالک سرور مشخص نیست؛ پشتیبانی باید اتصال سرور را بررسی کند')
  return manager
}
export function managementDto(op: Operation) {
  const meta = op.responseMetadata as { actionId?: number; accepted?: boolean; reconciledAt?: string } | null
  const ipChange = op.action === 'replace_primary_ipv4'
  const unknown = op.status === 'unknown' || op.status === 'needs_reconciliation' || (!ipChange && operationDelayed(op))
  return { id: op.id, action: op.action, status: op.status === 'succeeded' ? 'confirmed' : op.status === 'failed' ? 'failed'
    : unknown ? 'outcome_unknown' : op.status === 'pending' ? 'queued' : meta?.accepted || (ipChange && meta?.actionId) ? 'provider_accepted' : 'dispatching',
    actionId: meta?.actionId || null, createdAt: op.createdAt.toISOString(), updatedAt: op.updatedAt.toISOString(),
    completedAt: op.completedAt?.toISOString() ?? null, needsOperator: isOrphanedPowerOperation(op) || (ipChange && unknown),
    message: op.status === 'failed' ? 'عملیات انجام نشد؛ حفاظت، وضعیت سرور یا دسترسی پروژه را بررسی کنید.' : isOrphanedPowerOperation(op)
      ? 'این درخواست رسید قابل پیگیری ندارد. شناسهٔ عملیات را برای بررسی سابقهٔ ارائه‌دهنده به پشتیبانی بدهید.'
      : unknown ? 'نتیجهٔ ارائه‌دهنده هنوز قابل تأیید نیست؛ وضعیت را دوباره بررسی کنید.' : null }
}

export function isOrphanedPowerOperation(op: Operation) {
  const receipt = op.responseMetadata as { actionId?: unknown; accepted?: unknown; command?: unknown } | null
  return op.provider === 'hetzner' && op.kind === 'server_action' && op.referenceType === 'server' &&
    (op.action === 'power_off' || op.action === 'power_on') && (op.status === 'unknown' || op.status === 'needs_reconciliation') && !op.completedAt &&
    op.attemptCount > 0 && !receipt?.actionId && !receipt?.accepted && !receipt?.command && !op.providerRequestId && !op.providerCorrelationId
}
function inputHash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export function findBlockingManagementOperation(db: DbOrTx, serverId: string) {
  return db.query.providerOperations.findFirst({ where: t => and(eq(t.referenceId, serverId),
    inArray(t.kind, ['server_action', 'server_management']), inArray(t.status, [...unresolved])), orderBy: t => [t.createdAt, t.id] })
}

export function managementBlock(server: Server, operationPending: boolean) {
  if (server.terminatedAt || server.status === 'terminated') return 'server_deleted'
  if (server.terminationState && server.terminationState !== 'delete_failed') return 'deletion_pending'
  if (!server.activatedAt || !['active', 'suspended'].includes(server.status)) return 'server_not_ready'
  return operationPending ? 'operation_pending' : null
}

export const managementConflict = {
  server_deleted: 'سرور حذف شده است', deletion_pending: 'عملیات حذف این سرور هنوز نهایی نشده است',
  server_not_ready: 'سرور هنوز آمادهٔ مدیریت نیست', operation_pending: 'ابتدا نتیجهٔ عملیات قبلی سرور را پیگیری کنید',
} as const
export async function requestManagement(db: DbClient, user: SessionUser, serverId: string, action: ManagementAction, input: Record<string, unknown>, key: string) {
  await getServerForUser(db, user.id, serverId)
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('no key update')
    const [server] = await tx.select().from(servers).where(and(eq(servers.id, serverId), eq(servers.userId, user.id))).for('update')
    if (!server) throw new NotFoundError()
    customerProvider(server)
    const businessKey = `management:${user.id}:${key}`
    const previous = await tx.query.providerOperations.findFirst({ where: t => eq(t.businessKey, businessKey) })
    const hash = inputHash({ serverId, action, input })
    if (previous) {
      if ((previous.requestMetadata as { hash?: string })?.hash !== hash) throw new ConflictError('این کلید برای درخواست دیگری استفاده شده است')
      return previous
    }
    const block = managementBlock(server, !!await findBlockingManagementOperation(tx, server.id))
    if (block) throw new ConflictError(managementConflict[block])
    if (['power_on', 'reboot', 'reset'].includes(action)) await assertPowerOnFunding(tx, server)
    const [op] = await tx.insert(providerOperations).values({ provider: server.provider, kind: 'server_management', action, referenceType: 'server', referenceId: server.id,
      businessKey, status: 'pending', requestMetadata: { input, hash, actorId: user.id, sessionId: user.sessionId, providerServerId: server.providerServerId } }).returning()
    if (action === 'delete') await tx.update(servers).set({ terminationState: 'deletion_requested', terminationRequestedAt: new Date() }).where(eq(servers.id, server.id))
    await writeAudit(tx, { actorId: user.id, action: `server.${action}.requested`, targetType: 'server', targetId: server.id, metadata: { operationId: op!.id } })
    return op!
  })
}

/** Same user lock as renewal. Never erase paid invoices or append speculative refunds. */
export async function confirmTermination(db: DbClient, serverId: string, operationId: string) {
  const owner = await db.query.servers.findFirst({ where: t => eq(t.id, serverId) })
  if (!owner) return
  await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for('no key update')
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update')
    if (!server || server.terminatedAt) return
    const operation = await tx.query.providerOperations.findFirst({ where: t => and(eq(t.id, operationId), eq(t.referenceId, server.id), eq(t.action, 'delete')) })
    if (!operation || (operation.requestMetadata as { providerServerId?: string } | null)?.providerServerId !== server.providerServerId) throw new ConflictError('درخواست حذف معتبر یافت نشد')
    const now = new Date()
    if (server.subscriptionId) {
      await tx.select().from(subscriptions).where(eq(subscriptions.id, server.subscriptionId)).for('update')
      await tx.update(subscriptions).set({ status: 'cancelled', autoRenew: false, cancelledAt: now, graceUntil: null, updatedAt: now }).where(and(eq(subscriptions.id, server.subscriptionId), eq(subscriptions.userId, server.userId)))
      await tx.update(invoices).set({ status: 'void' }).where(and(eq(invoices.subscriptionId, server.subscriptionId), inArray(invoices.status, ['open', 'overdue', 'draft'])))
      await tx.update(renewalAttempts).set({ status: 'cancelled', error: 'provider-confirmed server termination' }).where(and(eq(renewalAttempts.subscriptionId, server.subscriptionId), eq(renewalAttempts.status, 'pending')))
      await tx.insert(subscriptionEvents).values({ subscriptionId: server.subscriptionId, event: 'provider_terminated', metadata: { operationId, policy: 'no_automatic_proration', confirmedAt: now.toISOString() } })
    }
    await tx.update(servers).set({ status: 'terminated', terminationState: 'terminated', terminatedAt: now, lastSyncedAt: now }).where(eq(servers.id, server.id))
    await tx.update(providerOperations).set({ status: 'failed', completedAt: now, updatedAt: now, lastError: 'server terminated; stale job cancelled' }).where(and(eq(providerOperations.referenceId, server.id), inArray(providerOperations.kind, ['server_action', 'server_management']), inArray(providerOperations.status, [...unresolved]), sql`${providerOperations.id} <> ${operationId}`))
    await tx.update(providerOperations).set({ status: 'succeeded', completedAt: now, updatedAt: now, responseMetadata: { ...((operation.responseMetadata ?? {}) as object), reconciledAt: now.toISOString(), providerAbsent: true } }).where(eq(providerOperations.id, operationId))
    await notifyServerOperation(tx, server, operation, 'succeeded')
    await tx.update(serverSecrets).set({ encrypted: null, acknowledgedAt: now }).where(eq(serverSecrets.serverId, server.id))
    await writeAudit(tx, { actorId: server.userId, action: 'server.termination.confirmed', targetType: 'server', targetId: server.id, metadata: { operationId, financialHistoryRetained: true, futureBillingStopped: true } })
  })
}

async function validateDispatch(db: DbClient, server: Server, action: ManagementAction, input: Record<string, unknown>) {
  const provider = customerProvider(server), view = await provider.inspect(server.providerServerId!), meta = view.metadata ?? {}
  if (view.providerServerId !== server.providerServerId) throw new ForbiddenError('مالکیت سرور قابل تأیید نیست')
  if (['power_on', 'resize'].includes(action) && view.state !== 'suspended') throw new ValidationError('برای این عملیات ابتدا سرور را خاموش کنید')
  if (['reboot', 'reset', 'shutdown'].includes(action) && view.state !== 'active') throw new ValidationError('این عملیات به سرور روشن نیاز دارد')
  const protection = meta.protection as { delete?: boolean; rebuild?: boolean } | undefined
  if ((action === 'delete' && protection?.delete) || (action === 'rebuild' && protection?.rebuild)) throw new ValidationError('حفاظت سرور فعال است؛ آن را با تأیید جداگانه تغییر دهید')
  if (action === 'resize') {
    const baseline = input.baseline as { serverType?: string; diskGb?: number; imageId?: string } | undefined
    if (!baseline || baseline.serverType !== meta.serverType || baseline.diskGb !== view.diskGb || baseline.imageId !== meta.imageId || typeof input.expiresAt !== 'string' || new Date(input.expiresAt).getTime() <= Date.now()) throw new ValidationError('وضعیت سرور یا پیش‌نمایش قیمت تغییر کرده است؛ دوباره بررسی کنید')
    const target = (await provider.resizeOptions(server.providerServerId!)).find(type => type.type === input.serverType)
    if (!target?.available || target.type === meta.serverType || target.diskGb < (view.diskGb ?? Infinity) || target.storageType !== meta.storageType) throw new ValidationError('پلن مقصد، ظرفیت دیسک یا نوع ذخیره‌سازی سازگار نیست')
  }
  if (action === 'rebuild') {
    const image = (await provider.images(server.providerServerId!)).find(image => image.id === input.image)
    if (!image || image.minDiskGb > (view.diskGb ?? 0)) throw new ValidationError('تصویر سیستم‌عامل برای این سرور مجاز نیست')
  }
}

export async function handleCustomerOperation(db: DbClient, operationId: string) {
  const operation = await db.query.providerOperations.findFirst({ where: t => eq(t.id, operationId) })
  if (!operation || !operation.action || !managementActions.includes(operation.action as ManagementAction) || operation.completedAt) return
  const server = await db.query.servers.findFirst({ where: t => eq(t.id, operation.referenceId) })
  if (!server) return
  if ((operation.requestMetadata as { providerServerId?: string } | null)?.providerServerId !== server.providerServerId) throw new ForbiddenError('پروژه یا شناسهٔ مالک سرور با درخواست ثبت‌شده مطابقت ندارد')
  const action = operation.action as ManagementAction, provider = customerProvider(server)
  if (operation.status !== 'pending') { await reconcileCustomerOperation(db, server, operation); return }
  const claim = await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    if (!current || current.terminatedAt || (action !== 'delete' && current.terminationState && current.terminationState !== 'delete_failed')) {
      await recordOperationFailure(tx, server, operation, 'server is terminating', 'failed', ['pending'])
      return false
    }
    if (['power_on', 'reboot', 'reset'].includes(action)) {
      try { await assertPowerOnFunding(tx, current) } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error
        await recordOperationFailure(tx, server, operation, 'insufficient funding before provider dispatch', 'failed', ['pending'])
        await writeAudit(tx, { actorId: server.userId, action: 'server.action.funding_rejected', targetType: 'server', targetId: server.id, metadata: { operationId: operation.id } })
        return false
      }
    }
    return !!(await tx.update(providerOperations).set({ status: 'running', attemptCount: sql`${providerOperations.attemptCount} + 1`, updatedAt: new Date() })
      .where(and(eq(providerOperations.id, operation.id), eq(providerOperations.status, 'pending'), isNull(providerOperations.completedAt))).returning({ id: providerOperations.id }))[0]
  })
  if (!claim) return
  let dispatched = false, accepted = false
  try {
    const input = (operation.requestMetadata as { input?: Record<string, unknown> })?.input ?? {}
    if (action === 'delete' && await provider.absent(server.providerServerId!)) { await confirmTermination(db, server.id, operation.id); return }
    await validateDispatch(db, server, action, input)
    dispatched = true
    const result = await provider.submit(server.providerServerId!, action, input)
    accepted = true
    const receipt = { actionId: result.actionId, accepted: true, command: result.command }
    // Secret output never enters operation metadata or histories.
    await db.transaction(async tx => {
      if (action === 'delete') await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, server.id)).for('update')
      const [recorded] = await tx.update(providerOperations).set({ responseMetadata: receipt, updatedAt: new Date() })
        .where(and(eq(providerOperations.id, operation.id), isNull(providerOperations.completedAt))).returning({ id: providerOperations.id })
      if (!recorded) return
      if (result.secret) await sealServerSecret(tx, server, operation, result.secret)
      if (action === 'delete') await tx.update(servers).set({ terminationState: 'deleting' }).where(eq(servers.id, server.id))
    })
    await reconcileCustomerOperation(db, server, { ...operation, status: 'running', responseMetadata: receipt })
  } catch (error) {
    const definite = !dispatched || (!accepted && (error instanceof ProviderPermanentError || (error instanceof AppError && [403, 409, 422].includes(error.status))))
    await recordOperationFailure(db, server, operation, definite ? 'provider action rejected or precondition not met'
      : 'provider outcome requires reconciliation', definite ? 'failed' : 'unknown', ['running', 'unknown'])
  }
}

export async function reconcileCustomerOperation(db: DbClient, server: Server, operation: Operation) {
  if (operation.completedAt || !operation.action || !managementActions.includes(operation.action as ManagementAction) || !reconcilable.some(status => status === operation.status)) return
  const requestedServerId = (operation.requestMetadata as { providerServerId?: string } | null)?.providerServerId
  if (operation.provider !== server.provider || (requestedServerId && requestedServerId !== server.providerServerId)) {
    throw new ProviderUnknownError('Provider operation belongs to a different server identity')
  }
  const provider = customerProvider(server), action = operation.action as ManagementAction
  if (action === 'delete' && await provider.absent(server.providerServerId!)) { await confirmTermination(db, server.id, operation.id); return }
  const receipt = operation.responseMetadata as { actionId?: number; command?: string; accepted?: boolean } | null
  const actionId = receipt?.actionId
  if (!actionId) {
    // Older releases discarded the Action ID after a proven accepted power
    // request. Only an observed target state can recover on/off, never reboot.
    if (operation.kind === 'server_action' && receipt?.accepted && ['power_on', 'power_off'].includes(action)) {
      const view = await provider.inspect(server.providerServerId!)
      if (view.state === (action === 'power_off' ? 'suspended' : 'active')) {
        await confirmCustomerOperation(db, server, operation, view)
        return
      }
    }
    // A running worker can still be saving the provider receipt.
    return
  }
  const observed = await provider.observe(server.providerServerId!, actionId)
  // The provider's receipt command can differ from the URL suffix. Older rows
  // only have the action ID, so accept the known aliases for that same action.
  const legacyCommand: Partial<Record<ManagementAction, string>> = {
    power_on: 'start_server', power_off: 'stop_server', shutdown: 'shutdown_server', reboot: 'reboot_server', reset: 'reset_server',
  }
  const expected = receipt?.command ? [receipt.command] : [hetznerCommands[action], legacyCommand[action]]
  if (!expected.includes(observed.command)) throw new ProviderUnknownError('Provider action command does not match the requested operation')
  if (observed.status === 'running') return
  if (observed.status === 'error') {
    await recordOperationFailure(db, server, operation, 'provider_action_failed', 'failed', ['running', 'unknown', 'needs_reconciliation'])
    return
  }
  const view = await provider.inspect(server.providerServerId!)
  if (action === 'delete') return // A success Action without authoritative absence is still unresolved.
  if (['power_off', 'shutdown'].includes(action) && view.state !== 'suspended') return
  if (['power_on', 'reboot', 'reset'].includes(action) && view.state !== 'active') return
  await confirmCustomerOperation(db, server, operation, view, actionId)
}

async function confirmCustomerOperation(db: DbClient, server: Server, operation: Operation, view: ProviderServerView, actionId?: number) {
  const action = operation.action
  await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, server.userId)).for('no key update')
    const [current] = await tx.select().from(servers).where(eq(servers.id, server.id)).for('update')
    if (!current || current.terminatedAt) return
    const [locked] = await tx.select().from(providerOperations).where(eq(providerOperations.id, operation.id)).for('update')
    if (!locked || locked.completedAt) return
    await updateServerFromView(tx, server.id, view)
    if (action === 'resize') await applyResizeSnapshot(tx, current, locked, view.metadata?.serverType)
    if (action === 'rebuild') {
      const image = (operation.requestMetadata as { input?: { image?: string } })?.input?.image
      if (view.metadata?.imageId !== image) return
      await tx.update(servers).set({ operatingSystem: image! }).where(eq(servers.id, server.id))
    }
    const now = new Date()
    await tx.update(providerOperations).set({ status: 'succeeded', lastError: null, responseMetadata: { ...((locked.responseMetadata ?? {}) as object), reconciledAt: now.toISOString() }, completedAt: now, updatedAt: now }).where(eq(providerOperations.id, operation.id))
    await notifyServerOperation(tx, current, locked, 'succeeded')
    await writeAudit(tx, { actorId: server.userId, action: `server.${action}.confirmed`, targetType: 'server', targetId: server.id, metadata: { operationId: operation.id, actionId } })
  })
}
async function applyResizeSnapshot(tx: DbOrTx, server: Server, op: Operation, observedType: unknown) {
  const input = (op.requestMetadata as { input?: { serverType?: string; priceRial?: number; quoteId?: string } })?.input
  if (!input?.serverType || input.serverType !== observedType || !Number.isSafeInteger(input.priceRial) || !input.priceRial || !server.subscriptionId) throw new ConflictError('پلن یا پیش‌نمایش قیمت با نتیجهٔ ارائه‌دهنده مطابقت ندارد')
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, server.subscriptionId)).for('update')
  if (!sub || sub.status === 'cancelled') throw new ConflictError('اشتراک دیگر قابل تغییر نیست')
  await tx.update(subscriptions).set({ priceRial: input.priceRial, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id))
  await tx.update(servers).set({ providerProductId: input.serverType + ':' + server.providerProductId.split(':').at(-1) }).where(eq(servers.id, server.id))
  await tx.insert(subscriptionEvents).values({ subscriptionId: sub.id, event: 'resize_price_confirmed', metadata: { operationId: op.id, quoteId: input.quoteId, previousPriceRial: sub.priceRial, futurePriceRial: input.priceRial, nextInvoiceAt: sub.nextInvoiceAt.toISOString(), settledPeriodsUnchanged: true } })
}
export async function reconcileCustomerOperations(db: DbClient, server: Server) {
  const operations = await db.query.providerOperations.findMany({ where: t => and(eq(t.referenceId, server.id), inArray(t.kind, ['server_management', 'server_action']), inArray(t.status, [...reconcilable])) })
  for (const operation of operations) await reconcileCustomerOperation(db, server, operation)
}
