import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import { containsSearch } from '../../lib/list-search.js'
import type { DbClient } from '../../db/index.js'
import { invoices } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'

export const customerInvoiceStatuses = ['all', 'pending', 'overdue', 'paid', 'cancelled', 'refunded'] as const

export async function listInvoices(db: DbClient, userId: string, opts: {
  limit: number; offset: number; search: string; status: typeof customerInvoiceStatuses[number]; now: Date
}) {
  const states = {
    all: undefined,
    pending: or(eq(invoices.status, 'draft'), and(eq(invoices.status, 'open'), gte(invoices.dueAt, opts.now))),
    overdue: or(eq(invoices.status, 'overdue'), and(eq(invoices.status, 'open'), lt(invoices.dueAt, opts.now))),
    paid: eq(invoices.status, 'paid'),
    cancelled: eq(invoices.status, 'void'),
    refunded: eq(invoices.status, 'refunded'),
  }
  const description = sql`case when ${invoices.description} ~ '^تمدید .*?[-—–]' then
    regexp_replace(regexp_replace(regexp_replace(${invoices.description}, 'HOURLY[[:space:]]*$', 'ساعتی'), 'DAILY[[:space:]]*$', 'روزانه'), 'MONTHLY[[:space:]]*$', 'ماهانه')
    else ${invoices.description} end`
  return db.query.invoices.findMany({
    where: and(eq(invoices.userId, userId), states[opts.status], opts.search
      ? containsSearch(sql`concat_ws(' ', ${invoices.invoiceNumber}, ${invoices.description}, ${description})`, opts.search) : undefined),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
    limit: opts.limit,
    offset: opts.offset,
  })
}

export async function getInvoice(db: DbClient, userId: string, invoiceId: string) {
  const invoice = await db.query.invoices.findFirst({ where: (t) => eq(t.id, invoiceId) })
  if (!invoice || invoice.userId !== userId) throw new NotFoundError('فاکتور یافت نشد')
  const items = await db.query.invoiceItems.findMany({ where: (t) => eq(t.invoiceId, invoice.id) })
  return { ...invoice, items }
}

export async function markInvoicePaid(db: DbClient, invoiceId: string) {
  const invoice = await db.query.invoices.findFirst({ where: (t) => eq(t.id, invoiceId) })
  if (!invoice) throw new NotFoundError('فاکتور یافت نشد')
  await db.update(invoices).set({ status: 'paid', paidAt: new Date() }).where(eq(invoices.id, invoiceId))
  await writeAudit(db, {
    action: 'invoice.paid',
    targetType: 'invoice',
    targetId: invoiceId,
    metadata: { invoiceNumber: invoice.invoiceNumber },
  })
  return invoice
}

export async function markInvoiceVoid(db: DbClient, invoiceId: string, actorId?: string) {
  const invoice = await db.query.invoices.findFirst({ where: (t) => eq(t.id, invoiceId) })
  if (!invoice) throw new NotFoundError('فاکتور یافت نشد')
  await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoiceId))
  await writeAudit(db, {
    actorId: actorId ?? null,
    action: 'invoice.voided',
    targetType: 'invoice',
    targetId: invoiceId,
    metadata: { invoiceNumber: invoice.invoiceNumber },
  })
}

export async function countOpenInvoices(db: DbClient, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(invoices)
    .where(and(eq(invoices.userId, userId), inArray(invoices.status, ['open', 'overdue'])))
  return Number(rows[0]?.n ?? 0)
}
