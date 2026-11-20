import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { orderEvents, orders, servers, walletTransactions } from '../../db/schema.js'
import { serverToDto } from '../../lib/dto.js'
import { NotFoundError } from '../../lib/errors.js'
import { provisionState, type ServerTracking, type ProvisioningFailure } from '../../contracts/server-lifecycle.js'
import { loadFundingFleet, serverPowerPolicy } from '../billing/funding.js'
import { linkedRefundReason } from '../provisioning/rejection.js'

export async function provisioningRow(db: DbClient, userId: string, orderId: string) {
  const order = await db.query.orders.findFirst({ where: t => and(eq(t.id, orderId), eq(t.userId, userId)) })
  if (!order) throw new NotFoundError('درخواست ساخت یافت نشد')
  const [server, operation] = await Promise.all([
    db.query.servers.findFirst({ where: t => and(eq(t.orderId, order.id), eq(t.userId, userId)) }),
    db.query.providerOperations.findFirst({ where: t => and(eq(t.kind, 'provision'), eq(t.referenceId, order.id)), orderBy: t => desc(t.createdAt) }),
  ])
  const meta = operation?.responseMetadata as Record<string, unknown> | null
  // A completed create call is not readiness. Only provider-observed activation is.
  const matched = order.status === 'requires_review' && server?.providerServerId && operation?.status === 'succeeded' && meta?.reconciled === true
  const state = server?.terminatedAt ? 'cancelled' : server?.activatedAt ? 'ready'
    : provisionState(order.status === 'active' || matched ? 'provisioning' : order.status, operation?.status)
  const tracking: ServerTracking = { source: 'site', reference: order.id, orderId: order.id, serverId: server?.id ?? null,
    operationId: operation?.id ?? null, state, createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString() }
  if (['failed', 'requires_review', 'outcome_unknown'].includes(state)) {
    const ledger = await db.query.walletTransactions.findMany({ where: t => and(eq(t.userId, userId), eq(t.referenceId, order.id),
      eq(t.referenceType, 'order'), inArray(t.type, ['purchase', 'refund'])) })
    const debit = ledger.filter(row => row.type === 'purchase').reduce((sum, row) => sum - row.amountRial, 0)
    const linked = order.status === 'refunded' ? await db.select({ amountRial: walletTransactions.amountRial }).from(orderEvents)
      .innerJoin(walletTransactions, sql`${walletTransactions.id}::text = ${orderEvents.metadata}->>'refundTransactionId'`)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.reason, linkedRefundReason), eq(walletTransactions.userId, userId),
        eq(walletTransactions.type, 'manual_credit'), eq(walletTransactions.referenceType, 'admin_adjustment'))).limit(1) : []
    const credit = ledger.filter(row => row.type === 'refund').reduce((sum, row) => sum + row.amountRial, linked[0]?.amountRial ?? 0)
    const billing = debit === 0 ? 'not_charged' : credit >= debit ? 'refunded' : 'captured'
    const unknown = state !== 'failed'
    const code: ProvisioningFailure['code'] = unknown ? 'outcome_unknown' : meta?.providerCode === 'resource_limit_exceeded' ? 'quota_exceeded'
      : meta?.providerCode === 'resource_unavailable' || operation?.lastError === 'Hetzner definitively rejected the request for capacity' ? 'capacity_unavailable' : 'provider_rejected'
    const message = code === 'capacity_unavailable' ? 'ظرفیت یا دسترسی پلن در دیتاسنتر انتخابی توسط سرویس‌دهنده تأیید نشد.'
      : code === 'quota_exceeded' ? 'سهمیهٔ ساخت سرور نزد سرویس‌دهنده کافی نیست.'
        : unknown ? 'نتیجهٔ ساخت هنوز قطعی نیست و در حال بررسی است.' : 'ساخت سرور توسط سرویس‌دهنده تأیید نشد.'
    const canChooseAlternative = code === 'capacity_unavailable' && billing !== 'captured'
    tracking.failure = { code, message, billing, reference: order.orderNumber, canChooseAlternative,
      nextStep: unknown ? 'سفارش تازه نسازید؛ با شمارهٔ پیگیری، نتیجه را از پشتیبانی بپرسید.'
        : canChooseAlternative ? 'پلن یا دیتاسنتر دیگری انتخاب کنید؛ ظرفیت لحظهٔ ثبت توسط سرویس‌دهنده مشخص می‌شود.'
          : 'با شمارهٔ پیگیری با پشتیبانی تماس بگیرید؛ پیش از تعیین تکلیف، سفارش را تکرار نکنید.' }
  }
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
