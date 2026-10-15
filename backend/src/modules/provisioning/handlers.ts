/**
 * Job handlers. These are plain functions (no BullMQ dependency) so they can
 * be unit-tested directly. The worker wraps them with retry/backoff.
 *
 * Safety invariants (tested):
 *  - A provider order is placed at most once per order: the provider operation
 *    row with a unique business key is created BEFORE the provider is called,
 *    so concurrent workers/retries can never double-order.
 *  - A network failure after dispatch marks the operation UNKNOWN and
 *    schedules reconciliation — never a blind re-order and never an
 *    automatic refund.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { invoices, invoiceItems, notifications, orderEvents, orders, providerOperations, renewalAttempts, servers, subscriptions } from '../../db/schema.js'
import {
  AppError,
  ProviderPermanentError,
  ProviderRetryableError,
  ProviderUnknownError,
} from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { syncProviderCatalog, findOfferByProductAndLocation } from '../catalog/service.js'
import { generateNumber, transitionOrder } from '../orders/service.js'
import { createServerRecord, activateServer, updateServerFromView } from '../servers/service.js'
import { createSubscription, enterGracePeriod, extendSubscriptionPeriod, findGraceExpiredSubscriptions, findSubscriptionsDueForRenewal, suspendSubscription } from '../subscriptions/service.js'
import { getProvider } from '../providers/registry.js'
import { applyWalletTransaction } from '../wallets/service.js'
import type { CloudQueues } from '../../jobs/queue.js'
import type { ProviderBillingOption, ProviderServerView, RecoveryResult } from '../providers/provider.interface.js'

export interface HandlerContext {
  db: DbClient
  queues: CloudQueues
}

const MAX_PROVISION_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Catalog sync
// ---------------------------------------------------------------------------
export async function handleCatalogSync(ctx: HandlerContext, data: { provider: string; actorId?: string | null }) {
  const provider = getProvider(data.provider)
  return syncProviderCatalog(ctx.db, provider, { actorId: data.actorId ?? null })
}

// ---------------------------------------------------------------------------
// Provision — the critical path
// ---------------------------------------------------------------------------
export async function handleProvision(ctx: HandlerContext, data: { orderId: string }): Promise<{ status: string; skipped?: boolean }> {
  const { db, queues } = ctx
  const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, data.orderId) })
  if (!order) return { status: 'order_not_found', skipped: true }

  const businessKey = `${order.provider}:provision:order:${order.id}`
  let op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.businessKey, businessKey) })

  // Terminal op states are decided by the operation record, not the order row:
  // - succeeded => no-op (idempotent replay), whatever the order status is.
  if (op && op.status === 'succeeded') return { status: 'already_provisioned', skipped: true }
  // - unknown => ambiguous provider result; reconcile, never re-order.
  if (op && op.status === 'unknown') {
    await queues.addReconcile(op.id)
    return { status: 'unknown_needs_reconciliation', skipped: true }
  }
  // - failed with exhausted attempts or an explicit permanent rejection =>
  //   never retried automatically.
  if (op && op.status === 'failed') {
    const meta = (op.responseMetadata ?? {}) as Record<string, unknown>
    if (op.attemptCount >= MAX_PROVISION_ATTEMPTS || meta.permanent === true) {
      return { status: 'permanently_failed', skipped: true }
    }
  }

  if (order.status !== 'paid' && order.status !== 'queued' && order.status !== 'provisioning') {
    return { status: 'not_ready', skipped: true }
  }

  if (!op) {
    // Create the operation BEFORE contacting the provider. The unique
    // business key makes double-creation impossible across concurrent
    // workers/retries.
    const [created] = await db
      .insert(providerOperations)
      .values({
        provider: order.provider,
        kind: 'provision',
        referenceType: 'order',
        referenceId: order.id,
        businessKey,
        status: 'pending',
        requestMetadata: {
          productId: order.providerProductId,
          location: order.providerLocation,
          operatingSystem: order.operatingSystem,
          hostname: order.hostname,
          clientReference: order.id,
        },
      })
      .onConflictDoNothing()
      .returning()
    op = created ?? (await db.query.providerOperations.findFirst({ where: (t) => eq(t.businessKey, businessKey) }))
  }
  if (!op) throw new Error('failed to create provider operation')

  // Atomic compare-and-set claim: only ONE worker per attempt may transition
  // pending/failed -> running. Losers skip. This is what prevents two worker
  // retries from ever placing two provider orders.
  const claimed = await db
    .update(providerOperations)
    .set({ status: 'running', attemptCount: op.attemptCount + 1, updatedAt: new Date() })
    .where(and(eq(providerOperations.id, op.id), inArray(providerOperations.status, ['pending', 'failed', 'needs_reconciliation'])))
    .returning({ id: providerOperations.id })
  if (!claimed[0]) {
    return { status: 'in_progress_or_done', skipped: true }
  }

  if (order.status === 'paid') {
    await transitionOrder(db, order.id, 'queued', { actorId: null, reason: 'provisioning started' })
  }
  await transitionOrder(db, order.id, 'provisioning', { actorId: null, reason: 'provider operation started' })

  const provider = getProvider(order.provider)
  const billingOption = order.billingOption as ProviderBillingOption | null

  try {
    await writeAudit(db, {
        action: 'provider.order.started',
        targetType: 'order',
        targetId: order.id,
        metadata: { provider: provider.id, businessKey },
      })

    // CONTACT THE PROVIDER. One attempt — retries happen at the job level and
    // are guarded by the operation status above.
    const result = await provider.createServer({
      productId: order.providerProductId,
      location: order.providerLocation,
      operatingSystem: order.operatingSystem,
      billingOption: billingOption ?? { billingCycle: 'monthly', label: 'Monthly', contractTerm: 0, periodMonths: 1, amountCents: 0 },
      hostname: order.hostname,
      clientReference: order.id,
    })

    // --- provider accepted the order ---------------------------------------
    const meta = (result.metadata ?? {}) as Record<string, unknown>
    const correlationId = asString(meta.providerCorrelationId)
    const requestId = asString(meta.requestId)
    if (!result.providerServerId) {
      throw new ProviderUnknownError('Provider accepted the order but has not returned a server id', {
        providerOrderId: result.providerOrderId, providerCorrelationId: correlationId, requestId,
      })
    }
    const offer = await findOfferByProductAndLocation(db, order.provider, order.providerProductId, order.providerLocation)

    const server = await createServerRecord(db, {
      userId: order.userId,
      orderId: order.id,
      provider: order.provider,
      providerOrderId: result.providerOrderId,
      providerServerId: result.providerServerId,
      providerProductId: order.providerProductId,
      providerLocation: order.providerLocation,
      hostname: order.hostname,
      operatingSystem: order.operatingSystem,
      vcpu: offer?.vcpu ?? 0,
      memoryMb: offer?.memoryMb ?? 0,
      diskGb: offer?.diskGb ?? 0,
      trafficLimitGb: offer?.trafficGb ?? null,
    })

    // Best-effort: fetch the resulting server to fill IPs.
    let view
    if (result.providerServerId) {
      try {
        view = await provider.getServer(result.providerServerId)
      } catch {
        view = undefined
      }
    }
    const ready = view?.state === 'active'
    if (view && ready) await finishServerActivation(db, server.id, view)
    else await queues.addServerSync(server.id, 15_000)
    await db
      .update(providerOperations)
      .set({
        status: 'succeeded',
        responseMetadata: { providerOrderId: result.providerOrderId, providerServerId: result.providerServerId, providerCorrelationId: correlationId, requestId },
        providerCorrelationId: correlationId,
        providerRequestId: requestId,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(providerOperations.id, op.id))

    await writeAudit(db, {
      actorId: order.userId,
      action: 'provider.order.completed',
      targetType: 'order',
      targetId: order.id,
      metadata: { providerServerId: result.providerServerId, providerOrderId: result.providerOrderId },
    })
    return { status: ready ? 'provisioned' : 'provisioning' }
  } catch (err) {
    if (err instanceof ProviderUnknownError) {
      // A dispatched request may have been accepted. Never re-order or auto-refund.
      const details = (err as AppError).details as Record<string, unknown> | undefined
      const correlationId = asString(details?.providerCorrelationId) ?? asString(details?.simulatedProviderCorrelationId)
      const requestId = asString(details?.requestId)
      await db
        .update(providerOperations)
        .set({
          status: 'unknown',
          lastError: err.message,
          providerCorrelationId: correlationId,
          providerRequestId: requestId,
          responseMetadata: { ...((op.responseMetadata ?? {}) as object), providerOrderId: asString(details?.providerOrderId), providerCorrelationId: correlationId, requestId, outcome: 'unknown' },
          updatedAt: new Date(),
        })
        .where(eq(providerOperations.id, op.id))
      await transitionOrder(db, order.id, 'requires_review', {
        actorId: null,
        reason: 'provider result unknown — reconciliation scheduled',
        metadata: { providerError: err.message, providerCorrelationId: correlationId },
      })
      await queues.addReconcile(op.id)
      return { status: 'unknown_scheduled_reconciliation' }
    }

    if (err instanceof ProviderRetryableError) {
      const attempts = op.attemptCount + 1
      await db
        .update(providerOperations)
        .set({ status: 'failed', lastError: err.message, updatedAt: new Date() })
        .where(eq(providerOperations.id, op.id))
      if (attempts >= MAX_PROVISION_ATTEMPTS) {
        await failServerOrder(ctx, order.id, err.message)
      }
      // Re-throw so BullMQ retries with backoff (unless attempts exhausted —
      // in that case the handler returns the permanent failure on the next
      // run because the op has no attempts left).
      if (attempts < MAX_PROVISION_ATTEMPTS) throw err
      return { status: 'retries_exhausted' }
    }

    if (err instanceof ProviderPermanentError) {
      const details = (err as AppError).details as Record<string, unknown> | undefined
      const correlationId = asString(details?.providerCorrelationId)
      const requestId = asString(details?.requestId)
      await db
        .update(providerOperations)
        .set({
          status: 'failed',
          lastError: err.message,
          completedAt: new Date(),
          updatedAt: new Date(),
          providerCorrelationId: correlationId,
          providerRequestId: requestId,
          // Terminal: a permanent rejection must never be retried, even though
          // attemptCount is below the retry cap.
          responseMetadata: { ...((op.responseMetadata ?? {}) as object), permanent: true, providerCorrelationId: correlationId, requestId, outcome: 'definitive_rejection' },
        })
        .where(eq(providerOperations.id, op.id))
      await failServerOrder(ctx, order.id, err.message)
      return { status: 'permanent_failure' }
    }

    // Unexpected error — the op may have been dispatched. Conservative:
    // mark UNKNOWN + reconcile, never blind-retry a possibly-dispached POST.
    await db
      .update(providerOperations)
      .set({ status: 'unknown', lastError: (err as Error).message, updatedAt: new Date() })
      .where(eq(providerOperations.id, op.id))
    await queues.addReconcile(op.id)
    throw err
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

async function failServerOrder(ctx: HandlerContext, orderId: string, error: string) {
  const { db } = ctx
  await transitionOrder(db, orderId, 'failed', { actorId: null, reason: error })
  const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, orderId) })
  if (order) {
    await db.update(orders).set({ error, updatedAt: new Date() }).where(eq(orders.id, orderId))
    await db.insert(notifications).values({
      userId: order.userId,
      title: 'ایجاد سرور ناموفق بود',
      body: error,
      type: 'error',
    })
  }
  await writeAudit(db, { action: 'provider.order.failed', targetType: 'order', targetId: orderId, metadata: { error } })
}

// ---------------------------------------------------------------------------
// Reconciliation — resolve UNKNOWN operations by asking the provider
// ---------------------------------------------------------------------------
//
// SAFETY CONTRACT (see provider.interface.ts): an UNKNOWN order outcome is
// only auto-resolved when the provider returns RecoveryResult.MATCHED, i.e.
// conclusive proof (a provider-issued id captured BEFORE the ambiguity and
// verified to exist at the provider). Hostname/product/location similarity,
// "there is only one candidate", timestamps, prices, billing cycles — none
// of these are proof. They are recorded as operator-facing candidate evidence
// while the operation stays under review. An UNKNOWN operation is NEVER
// re-POSTed automatically and NEVER auto-refunded.
// ---------------------------------------------------------------------------
export async function handleReconcile(ctx: HandlerContext, data: { operationId?: string }): Promise<{ resolved: number; underReview: number }> {
  const { db, queues } = ctx
  const ops = data.operationId
    ? [await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, data.operationId ?? '') })]
    : await db.query.providerOperations.findMany({
        where: (t) => eq(t.status, 'unknown'),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
        limit: 20,
      })

  let resolved = 0
  let underReview = 0
  for (const op of ops) {
    if (!op) continue
    if (op.status !== 'unknown') continue
    const provider = getProvider(op.provider)
    if (!provider.supports('reconcile') || !provider.reconcileOrder) {
      await markUnderReview(db, op.id, 'provider does not support order reconciliation')
      underReview++
      continue
    }

    const responseMeta = (op.responseMetadata ?? {}) as Record<string, unknown>
    const requestMeta = (op.requestMetadata ?? {}) as Record<string, unknown>

    let result: RecoveryResult
    try {
      result = await provider.reconcileOrder({
        knownProviderOrderId: asString(responseMeta.providerOrderId),
        knownProviderServerId: asString(responseMeta.providerServerId),
        requested: {
          productId: asString(requestMeta.productId),
          location: asString(requestMeta.location),
          operatingSystem: asString(requestMeta.operatingSystem),
          hostname: asString(requestMeta.hostname),
          billingOption: requestMeta.billingOption as never,
          clientReference: asString(requestMeta.clientReference),
        },
      })
    } catch (err) {
      await markUnderReview(db, op.id, `provider reconciliation failed: ${(err as Error).message}`)
      underReview++
      continue
    }

    if (result.resolution === 'MATCHED' && result.providerServerId) {
      // Conclusive proof — safe to attach.
      await completeOrderFromRecovery(db, op, result)
      resolved++
      continue
    }

    if (result.resolution === 'NO_MATCH') {
      // The provider can prove (via an exact id lookup) the resource does not
      // exist. Stay under review: an operator decides between rejection and
      // refund — never an automatic refund.
      await markUnderReview(db, op.id, result.reason ?? 'provider reports no match')
      underReview++
      continue
    }

    // AMBIGUOUS / UNSUPPORTED: record candidate evidence, keep under review.
    await markUnderReview(db, op.id, result.reason ?? 'provider could not prove ownership', result.candidates)
    underReview++
  }
  void queues
  return { resolved, underReview }
}

/**
 * Manual operator resolution of an UNKNOWN operation (admin routes).
 * - mark-match: the operator explicitly confirms the external provider
 *   server id; the order completes deterministically (same path as a
 *   conclusive MATCHED recovery).
 * - mark-rejected: the operator confirms no server was created; the order
 *   fails. Wallet funds are NOT touched automatically — refund is a
 *   separate explicit admin action (see refundOrderOperation).
 */
export async function resolveOperationByAdmin(
  db: DbClient,
  operationId: string,
  input: { actorId: string; action: 'mark-match' | 'mark-rejected'; providerServerId?: string; note?: string },
): Promise<void> {
  const op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, operationId) })
  if (!op) throw new AppError(404, 'not_found', 'عملیات سرویس‌دهنده یافت نشد')
  if (op.status !== 'unknown' && op.status !== 'needs_reconciliation') {
    throw new AppError(409, 'conflict', `فقط عملیات‌های UNKNOWN قابل تعیین تکلیف دستی هستند (وضعیت فعلی: ${op.status})`)
  }

  if (input.action === 'mark-match') {
    if (!input.providerServerId) {
      throw new AppError(422, 'validation_error', 'برای تأیید تطابق، شناسه سرور سرویس‌دهنده (providerServerId) الزامی است')
    }
    // Operator-confirmed id — treat as conclusive proof.
    await completeOrderFromRecovery(db, op, {
      resolution: 'MATCHED',
      providerServerId: input.providerServerId,
      reason: `confirmed manually by operator (${input.actorId})`,
    })
    await writeAudit(db, {
      actorId: input.actorId,
      action: 'admin.provider_operation.mark_match',
      targetType: 'provider_operation',
      targetId: op.id,
      metadata: { providerServerId: input.providerServerId, note: input.note ?? null, businessKey: op.businessKey },
    })
    return
  }

  // mark-rejected
  await db
    .update(providerOperations)
    .set({
      status: 'failed',
      lastError: input.note ?? 'rejected manually by operator',
      completedAt: new Date(),
      updatedAt: new Date(),
      responseMetadata: { ...((op.responseMetadata ?? {}) as object), permanent: true, rejectedByOperator: true, note: input.note ?? null },
    })
    .where(eq(providerOperations.id, op.id))
  if (op.referenceType === 'order') {
    await transitionOrder(db, op.referenceId, 'failed', {
      actorId: input.actorId,
      reason: 'operator confirmed no provider server was created',
    })
    await db.update(orders).set({ error: input.note ?? 'operator rejected the operation', updatedAt: new Date() }).where(eq(orders.id, op.referenceId))
    await db.insert(notifications).values({
      userId: (await db.query.orders.findFirst({ where: (t) => eq(t.id, op.referenceId) }))?.userId ?? '',
      title: 'بررسی سفارش کامل شد',
      body: 'هیچ سروری توسط سرویس‌دهنده ساخته نشده است؛ سفارش لغو شد. بازگشت وجه به‌صورت جداگانه انجام می‌شود.',
      type: 'warning',
    })
  }
  await writeAudit(db, {
    actorId: input.actorId,
    action: 'admin.provider_operation.mark_rejected',
    targetType: 'provider_operation',
    targetId: op.id,
    metadata: { note: input.note ?? null, businessKey: op.businessKey },
  })
}

/** Keep the operation under review with evidence + audit; order stays requires_review. */
async function markUnderReview(db: DbClient, opId: string, reason: string, candidates?: RecoveryResult['candidates']) {
  const op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, opId) })
  if (!op) return
  const responseMeta = (op.responseMetadata ?? {}) as Record<string, unknown>
  const next: Record<string, unknown> = {
    status: 'unknown',
    lastError: reason,
    responseMetadata: {
      ...responseMeta,
      recovery: {
        lastAttemptAt: new Date().toISOString(),
        reason,
        // Operator-facing evidence ONLY — never used for automatic attachment.
        candidateProviderServerIds: candidates?.map((c) => c.providerServerId).filter(Boolean) ?? [],
        candidateHostnames: candidates?.map((c) => c.hostname).filter(Boolean) ?? [],
        candidateCreatedAt: candidates?.map((c) => c.createdAt).filter(Boolean) ?? [],
        automaticAttachmentRefused: true,
      },
    },
    updatedAt: new Date(),
  }
  await db.update(providerOperations).set(next).where(eq(providerOperations.id, opId))
  await writeAudit(db, {
    action: 'provider.order.needs_manual_review',
    targetType: 'provider_operation',
    targetId: opId,
    metadata: { businessKey: op.businessKey, provider: op.provider, reason, candidateCount: candidates?.length ?? 0 },
  })
}

/** Complete the order from a conclusively MATCHED recovery result. */
export async function completeOrderFromRecovery(db: DbClient, op: typeof providerOperations.$inferSelect, result: RecoveryResult) {
  const order = op.referenceType === 'order' ? await db.query.orders.findFirst({ where: (t) => eq(t.id, op.referenceId) }) : null
  const serverId = result.providerServerId!

  if (order && order.status === 'requires_review') {
    const offer = await findOfferByProductAndLocation(db, order.provider, order.providerProductId, order.providerLocation)
    const server = await createServerRecord(db, {
      userId: order.userId,
      orderId: order.id,
      provider: op.provider,
      providerOrderId: result.providerOrderId ?? (asString(((op.responseMetadata ?? {}) as Record<string, unknown>).providerOrderId) as string | undefined),
      providerServerId: serverId,
      providerProductId: order.providerProductId,
      providerLocation: order.providerLocation,
      hostname: order.hostname,
      operatingSystem: order.operatingSystem,
      vcpu: offer?.vcpu ?? 0,
      memoryMb: offer?.memoryMb ?? 0,
      diskGb: offer?.diskGb ?? 0,
      trafficLimitGb: offer?.trafficGb ?? null,
    })
    // Best-effort view refresh (server must exist — MATCHED proof).
    let view
    try {
      view = await getProvider(op.provider).getServer(serverId)
    } catch {
      view = undefined
    }
    if (view?.state === 'active') await finishServerActivation(db, server.id, view)
    await db
      .update(providerOperations)
      .set({ status: 'succeeded', lastError: null, responseMetadata: { ...((op.responseMetadata ?? {}) as object), reconciled: true, providerServerId: serverId, providerOrderId: result.providerOrderId }, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(providerOperations.id, op.id))
    await writeAudit(db, {
      action: 'provider.order.completed',
      targetType: 'order',
      targetId: order.id,
      metadata: { providerServerId: serverId, via: 'reconciliation' },
    })
    return
  }

  // Order missing or not in requires_review — record the resolved op only.
  const responseMeta = (op.responseMetadata ?? {}) as Record<string, unknown>
  await db
    .update(providerOperations)
    .set({ status: 'succeeded', responseMetadata: { ...responseMeta, reconciled: true, providerServerId: serverId, providerOrderId: result.providerOrderId }, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(providerOperations.id, op.id))
}

// ---------------------------------------------------------------------------
// Server sync + actions
// ---------------------------------------------------------------------------
export async function handleServerSync(ctx: HandlerContext, data: { serverId?: string }) {
  const { db, queues } = ctx
  if (!data.serverId) {
    const pending = await db.query.servers.findMany({ where: (t) => eq(t.status, 'provisioning') })
    for (const server of pending) await queues.addServerSync(server.id)
    return { status: 'queued' }
  }
  const server = await db.query.servers.findFirst({ where: (t) => eq(t.id, data.serverId!) })
  if (!server?.providerServerId) return { status: 'skipped' }
  const view = await getProvider(server.provider).getServer(server.providerServerId)
  if (view.state === 'active' && !server.subscriptionId) await finishServerActivation(db, server.id, view)
  await updateServerFromView(db, server.id, view)
  return { status: 'synced' }
}

/** Start the purchased period only after the provider proves the server is running. */
async function finishServerActivation(db: DbClient, serverId: string, view: ProviderServerView) {
  await db.transaction(async (tx) => {
    const [server] = await tx.select().from(servers).where(eq(servers.id, serverId)).for('update').limit(1)
    if (!server || server.subscriptionId) return
    const order = await tx.query.orders.findFirst({ where: (t) => eq(t.id, server.orderId) })
    if (!order || (order.status !== 'provisioning' && order.status !== 'requires_review')) return
    await activateServer(tx, server.id, view)
    const sub = await createSubscription(tx, {
      userId: order.userId, serverId: server.id, orderId: order.id,
      priceRial: order.totalRial, billingInterval: order.billingInterval,
    })
    await tx.update(servers).set({ subscriptionId: sub.id }).where(eq(servers.id, server.id))
    await tx.update(orders).set({ status: 'active', updatedAt: new Date() }).where(eq(orders.id, order.id))
    await tx.insert(orderEvents).values({ orderId: order.id, fromStatus: order.status, toStatus: 'active', reason: 'provider server is running' })
    await tx.insert(notifications).values({ userId: order.userId, title: 'سرور شما آماده است', body: `سرور ${order.hostname} با موفقیت ساخته شد.`, type: 'success' })
  })
}

export async function handleServerAction(
  ctx: HandlerContext,
  data: { operationId: string; serverId: string; action: 'power_on' | 'power_off' | 'reboot' },
) {
  const { db } = ctx
  const op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, data.operationId) })
  if (!op) return { status: 'operation_not_found' }
  if (op.status === 'succeeded') return { status: 'already_done' }
  if (op.status === 'running' || op.status === 'pending') return { status: 'in_progress' }

  const server = await db.query.servers.findFirst({ where: (t) => eq(t.id, data.serverId) })
  if (!server || !server.providerServerId) return { status: 'server_not_ready' }

  await db.update(providerOperations).set({ status: 'running', attemptCount: op.attemptCount + 1, updatedAt: new Date() }).where(eq(providerOperations.id, op.id))
  const provider = getProvider(server.provider)

  try {
    if (data.action === 'power_on') await provider.powerOn(server.providerServerId)
    else if (data.action === 'power_off') await provider.powerOff(server.providerServerId)
    else if (data.action === 'reboot') await provider.reboot(server.providerServerId)
    else throw new ProviderPermanentError(`Unknown server action: ${data.action}`)

    await db
      .update(providerOperations)
      .set({ status: 'succeeded', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(providerOperations.id, op.id))
    return { status: 'done' }
  } catch (err) {
    await db
      .update(providerOperations)
      .set({ status: err instanceof ProviderRetryableError ? 'failed' : 'failed', lastError: (err as Error).message, updatedAt: new Date() })
      .where(eq(providerOperations.id, op.id))
    throw err
  }
}

// ---------------------------------------------------------------------------
// Billing: renew only at the purchased hourly/daily/monthly boundary.
// ---------------------------------------------------------------------------
export async function handleRenewalSweep(ctx: HandlerContext): Promise<{ renewed: number; failed: number; suspended: number }> {
  const { db, queues } = ctx
  const subs = await findSubscriptionsDueForRenewal(db, 0)
  let renewed = 0
  let failed = 0

  for (const sub of subs) {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).for('update').limit(1)
      if (!current || current.nextInvoiceAt > new Date()) return 'skipped'
      if (current.status !== 'active' && current.status !== 'grace') return 'skipped'
      const order = current.orderId ? await tx.query.orders.findFirst({ where: (t) => eq(t.id, current.orderId!) }) : null
      // An unpaid period reuses its existing invoice on every sweep.
      let invoice = await tx.query.invoices.findFirst({
        where: (t) => and(eq(t.subscriptionId, current.id), eq(t.status, 'open')),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      })
      if (!invoice) {
        const invoiceNumber = await generateNumber(tx, 'INV', invoices, invoices.invoiceNumber)
        const [created] = await tx.insert(invoices).values({
          invoiceNumber,
          userId: current.userId,
          orderId: current.orderId,
          subscriptionId: current.id,
          status: 'open',
          subtotalRial: current.priceRial,
          taxRial: 0,
          discountRial: 0,
          totalRial: current.priceRial,
          description: `تمدید اشتراک ${order?.hostname ?? 'سرور'} — ${current.billingInterval}`,
          snapshot: { priceRial: current.priceRial, billingInterval: current.billingInterval, periodStart: current.currentPeriodEnd.toISOString() },
          issuedAt: new Date(),
          dueAt: current.currentPeriodEnd,
        }).returning()
        if (!created) throw new Error('failed to create renewal invoice')
        invoice = created
        await tx.insert(invoiceItems).values({
          invoiceId: invoice.id,
          description: `تمدید ${current.billingInterval} — ${order?.hostname ?? 'سرور'}`,
          quantity: 1,
          unitAmountRial: current.priceRial,
          totalRial: current.priceRial,
          referenceType: 'subscription',
          referenceId: current.id,
        })
        if (!current.autoRenew) {
          await tx.insert(notifications).values({
            userId: current.userId,
            title: 'فاکتور تمدید صادر شد',
            body: `فاکتور ${invoice.invoiceNumber} به مبلغ ${current.priceRial} ریال صادر شد.`,
            type: 'info',
          })
        }
      }
      if (!current.autoRenew) return 'skipped'
      const [attempt] = await tx.insert(renewalAttempts).values({
        subscriptionId: current.id,
        invoiceId: invoice.id,
        status: 'pending',
        amountRial: current.priceRial,
      }).returning()
      if (!attempt) throw new Error('failed to create renewal attempt')
      const wallet = order?.walletId
        ? await tx.query.wallets.findFirst({ where: (t) => and(eq(t.id, order.walletId!), eq(t.userId, current.userId)) })
        : await tx.query.wallets.findFirst({ where: (t) => and(eq(t.userId, current.userId), eq(t.isDefault, true)) })
      try {
        if (!wallet) throw new AppError(422, 'insufficient_funds', 'کیف پول پرداخت یافت نشد')
        await applyWalletTransaction(tx, current.userId, wallet.id, {
          amountRial: current.priceRial,
          type: 'renewal',
          referenceType: 'subscription',
          referenceId: current.id,
          idempotencyKey: `renewal:${invoice.id}`,
          description: `پرداخت خودکار تمدید ${invoice.invoiceNumber}`,
        })
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'insufficient_funds') throw err
        await tx.update(renewalAttempts).set({ status: 'insufficient_funds', error: (err as Error).message }).where(eq(renewalAttempts.id, attempt.id))
        if (current.status !== 'grace') {
          await enterGracePeriod(tx, current.id)
          await tx.insert(notifications).values({
            userId: current.userId,
            title: 'تمدید ناموفق بود',
            body: `موجودی برای پرداخت فاکتور ${invoice.invoiceNumber} کافی نیست.`,
            type: 'warning',
          })
        }
        return 'failed'
      }
      await tx.update(invoices).set({ status: 'paid', paidAt: new Date() }).where(eq(invoices.id, invoice.id))
      await tx.update(renewalAttempts).set({ status: 'succeeded' }).where(eq(renewalAttempts.id, attempt.id))
      await extendSubscriptionPeriod(tx, current.id)
      return 'renewed'
    })
    if (outcome === 'renewed') renewed++
    if (outcome === 'failed') failed++
  }

  // Grace expiry: suspend services past their grace period.
  const expired = await findGraceExpiredSubscriptions(db)
  let suspended = 0
  for (const sub of expired) {
    await suspendSubscription(db, sub.id)
    if (sub.serverId) await db.update(servers).set({ status: 'suspended' }).where(eq(servers.id, sub.serverId))
    await db.insert(notifications).values({
      userId: sub.userId,
      title: 'سرویس به حالت تعلیق درآمد',
      body: 'مهلت پرداخت به پایان رسیده است. برای فعال‌سازی مجدد، فاکتور را پرداخت کنید.',
      type: 'warning',
    })
    suspended++
  }

  void queues
  return { renewed, failed, suspended }
}