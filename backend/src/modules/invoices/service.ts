import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { invoices } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'

export async function listInvoices(db: DbClient, userId: string, opts: { limit?: number; offset?: number } = {}) {
  return db.query.invoices.findMany({
    where: (t) => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
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
    .where(and(eq(invoices.userId, userId), eq(invoices.status, 'open')))
  return Number(rows[0]?.n ?? 0)
}