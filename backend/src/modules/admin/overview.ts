import { desc, eq, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { orders, providerOperations, servers, users, walletTransactions } from '../../db/schema.js'
import { ConflictError } from '../../lib/errors.js'
import { linkedRefundReason } from '../provisioning/rejection.js'

const serverState = sql<string>`case when ${servers.terminatedAt} is not null or ${servers.terminationState} = 'terminated'
  then 'terminated' else ${servers.status}::text end`
const acceptableOrders = sql`('paid', 'queued', 'provisioning', 'active')`
export const pendingOrderStatuses = ['awaiting_payment', 'requires_review', 'paid', 'queued', 'provisioning'] as const

// Compare linked wallet postings with initial invoices independently of renewal invoices.
const linkedRefunds = sql`
  select e.order_id, w.id as transaction_id, w.user_id, w.amount_rial, w.created_at
  from order_events e join wallet_transactions w on w.id::text = e.metadata->>'refundTransactionId'
  where e.reason = ${linkedRefundReason} and w.type = 'manual_credit' and w.reference_type = 'admin_adjustment'
`
const orderEvidence = sql`
  with order_postings as (
    select reference_id, user_id, id, type::text, amount_rial, created_at
    from wallet_transactions where reference_type = 'order' and type in ('purchase', 'refund', 'adjustment', 'manual_credit', 'manual_debit')
    union all
    select order_id, user_id, transaction_id, 'refund', amount_rial, created_at from (${linkedRefunds}) linked
  ), ledger as (
    select reference_id, user_id,
      coalesce(sum(-amount_rial) filter (where type = 'purchase' and amount_rial < 0), 0) as debit,
      coalesce(sum(amount_rial) filter (where type = 'refund' and amount_rial > 0), 0) as refund,
      array_agg(id order by created_at, id) as transactions
    from order_postings
    group by reference_id, user_id
  ), receipts as (
    select order_id, user_id, coalesce(sum(total_rial) filter (where status = 'paid'),0) as paid,
      count(*) filter (where status = 'paid') as paid_count, array_agg(id order by issued_at, id) as invoices
    from invoices where subscription_id is null and order_id is not null group by order_id, user_id
  ), evidence as (
    select o.id, o.order_number, o.status, o.created_at, coalesce(l.debit,0) as debit,
      coalesce(l.refund,0) as refund, coalesce(r.paid,0) as invoiced,
      coalesce(l.transactions,'{}'::uuid[]) as transactions, coalesce(r.invoices,'{}'::uuid[]) as invoices,
      (o.status = 'failed' and coalesce(l.debit,0) > coalesce(l.refund,0)) as unreturned,
      (coalesce(r.paid_count,0) > 0 and (coalesce(l.debit,0) <> r.paid or coalesce(l.refund,0) > 0 or r.paid_count > 1)
        or o.status in ${acceptableOrders} and (coalesce(r.paid_count,0) = 0 or coalesce(l.debit,0) <> o.total_rial)
        or o.status = 'refunded' and (coalesce(l.debit,0) <> coalesce(l.refund,0) or coalesce(l.debit,0) <> o.total_rial)) as mismatch
    from orders o left join ledger l on l.reference_id = o.id and l.user_id = o.user_id
    left join receipts r on r.order_id = o.id and r.user_id = o.user_id
  )`

function rial(value: string | undefined) {
  const parsed = Number(value ?? '0')
  if (!Number.isSafeInteger(parsed)) throw new ConflictError('مبلغ گزارش خارج از محدودهٔ امن نمایش است')
  return parsed
}
type EvidenceRow = { id: string; order_number: string; debit: string; refund: string; invoiced: string; unreturned: boolean; mismatch: boolean;
  transactions: string[]; invoices: string[] }

export async function readOrderFinancialEvidence(db: DbOrTx, id: string) {
  const [evidence, operations, adjustments] = await Promise.all([
    db.execute<EvidenceRow>(sql`${orderEvidence} select * from evidence where id = ${id}`),
    db.select({ id: providerOperations.id, status: providerOperations.status, kind: providerOperations.kind }).from(providerOperations)
      .where(sql`${providerOperations.referenceType} = 'order' and ${providerOperations.referenceId} = ${id}`).orderBy(desc(providerOperations.createdAt)),
    db.select({ id: walletTransactions.id, type: walletTransactions.type, amountRial: walletTransactions.amountRial, referenceType: walletTransactions.referenceType,
      referenceId: walletTransactions.referenceId, createdAt: walletTransactions.createdAt }).from(walletTransactions)
      .innerJoin(orders, eq(orders.userId, walletTransactions.userId)).where(sql`${orders.id} = ${id}
        and ${walletTransactions.type} in ('manual_credit','manual_debit','adjustment')`).orderBy(desc(walletTransactions.createdAt)).limit(20),
  ])
  const row = evidence.rows[0]
  if (!row) return null
  return { debitRial: rial(row.debit), refundRial: rial(row.refund), invoicedRial: rial(row.invoiced), invoiceIds: row.invoices,
    transactionIds: row.transactions, operations, adjustments, unreturned: row.unreturned, mismatch: row.mismatch }
}

export function readAdminOverview(db: DbClient, financialAccess: boolean) {
  return db.transaction(async tx => {
    const accounts = await tx.select({ role: users.role, status: users.status, count: sql<number>`count(*)::int` }).from(users).groupBy(users.role, users.status)
    const orderCounts = await tx.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).groupBy(orders.status)
    const serverCounts = await tx.select({ status: serverState, count: sql<number>`count(*)::int` }).from(servers).groupBy(serverState)
    const recentOrders = await tx.select({ order: orders, serverStatus: sql<string | null>`case when ${servers.id} is not null then ${serverState} end` }).from(orders)
      .leftJoin(servers, eq(servers.orderId, orders.id)).orderBy(desc(orders.createdAt), desc(orders.id)).limit(5)
    const checked = await tx.execute<{ checked_at: string; overdue: number; failed_renewals: number }>(sql`
        select (extract(epoch from transaction_timestamp()) * 1000)::bigint::text as checked_at,
        (select count(*)::int from subscriptions where status in ('active','grace','suspended') and next_invoice_at < transaction_timestamp()) as overdue,
        (select count(*)::int from renewal_attempts where status in ('insufficient_funds','failed') and attempted_at >= transaction_timestamp() - interval '24 hours') as failed_renewals`)
    const timestamp = checked.rows[0]!
    const statuses = (rows: { status: string; count: number }[]) => Object.fromEntries(rows.map(row => [row.status, row.count]))
    let finance
    if (financialAccess) {
      const totals = await tx.execute<{ initial: string; renewals: string; traffic: string; refunds: string; net: string; deposits: string }>(sql`
          select coalesce(sum(-w.amount_rial) filter (where w.type = 'purchase' and w.amount_rial < 0
            and w.reference_type = 'order' and o.status in ${acceptableOrders}),0)::text as initial,
            coalesce(sum(-w.amount_rial) filter (where w.type = 'renewal' and w.amount_rial < 0),0)::text as renewals,
            coalesce(sum(-w.amount_rial) filter (where w.type = 'traffic_overage' and w.amount_rial < 0),0)::text as traffic,
            coalesce(sum(w.amount_rial) filter (where w.amount_rial > 0 and
              ((w.type = 'refund' and w.reference_type in ('order','subscription','invoice')) or l.transaction_id is not null)),0)::text as refunds,
            coalesce(sum(-w.amount_rial) filter (where (w.type in ('purchase','renewal','traffic_overage') and w.amount_rial < 0)
              or (w.amount_rial > 0 and ((w.type = 'refund' and w.reference_type in ('order','subscription','invoice')) or l.transaction_id is not null))),0)::text as net,
            coalesce(sum(w.amount_rial) filter (where w.type = 'deposit' and w.amount_rial > 0),0)::text as deposits
          from wallet_transactions w left join orders o on w.reference_type = 'order' and o.id = w.reference_id and o.user_id = w.user_id
          left join (${linkedRefunds}) l on l.transaction_id = w.id
          join wallets v on v.id = w.wallet_id and v.currency = 'IRR'`)
      const exceptions = await tx.execute<EvidenceRow & { total: number }>(sql`${orderEvidence}
          select *, count(*) over()::int as total from evidence where unreturned or mismatch order by unreturned desc, created_at desc, id limit 20`)
      const renewalMismatch = await tx.execute<{ total: number }>(sql`select count(*)::int as total from invoices i where i.subscription_id is not null and i.status = 'paid'
          and i.total_rial <> coalesce((select sum(-w.amount_rial) from wallet_transactions w where w.user_id = i.user_id
            and ((w.type = 'renewal' and w.idempotency_key = 'renewal:' || i.id::text)
              or (w.type = 'traffic_overage' and w.reference_type = 'invoice' and w.reference_id = i.id))),0)`)
      const t = totals.rows[0]!
      finance = { initialRial: rial(t.initial), renewalRial: rial(t.renewals), trafficRial: rial(t.traffic), refundsRial: rial(t.refunds), netRial: rial(t.net), depositsRial: rial(t.deposits),
        exceptionCount: exceptions.rows[0]?.total ?? 0, renewalMismatchCount: renewalMismatch.rows[0]?.total ?? 0,
        exceptions: exceptions.rows.map(row => ({ id: row.id, orderNumber: row.order_number, debitRial: rial(row.debit), refundRial: rial(row.refund),
          invoicedRial: rial(row.invoiced), unreturned: row.unreturned, mismatch: row.mismatch })),
      }
    }
    return { accounts, orderCounts: statuses(orderCounts), serverCounts: statuses(serverCounts), recentOrders, checkedAt: new Date(Number(timestamp.checked_at)).toISOString(),
      overdue: timestamp.overdue, failedRenewals24h: timestamp.failed_renewals, finance }
  }, { accessMode: 'read only', isolationLevel: 'repeatable read' })
}
