import { enqueueSms } from '../notifications/sms.js'
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { servers, tickets, ticketReplies } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { ticketToDto } from '../../lib/dto.js'
import { publishNotification } from '../notifications/service.js'
import { containsSearch } from '../../lib/list-search.js'

// Keep the outer ID qualified when Drizzle renders this as a selected expression.
const hasUnreadReply = sql<boolean>`exists (select 1 from ${ticketReplies} where
  ${ticketReplies.ticketId} = ${tickets}.${sql.identifier(tickets.id.name)} and ${ticketReplies.customerReadAt} is null)`

export async function listCustomerTickets(db: DbClient, userId: string, filters: {
  search: string; status: string; department: string; limit: number; offset: number
}) {
  const rows = await db.select({ ticket: tickets, unread: hasUnreadReply }).from(tickets)
    .where(and(eq(tickets.userId, userId), filters.status === 'all' ? undefined : eq(tickets.status, filters.status),
      filters.department === 'all' ? undefined : eq(tickets.department, filters.department),
      filters.search ? containsSearch(tickets.title, filters.search) : undefined))
    .orderBy(desc(tickets.updatedAt), desc(tickets.id)).limit(filters.limit).offset(filters.offset)
  return rows.map(row => ticketToDto({ ...row.ticket, unread: row.unread }))
}

export async function customerTicketSummary(db: DbClient, userId: string) {
  const [counts] = await db.select({
    total: sql<number>`count(*)::int`,
    open: sql<number>`(count(*) filter (where ${tickets.status} in ('pending', 'review')))::int`,
    reviewing: sql<number>`(count(*) filter (where ${tickets.status} = 'review'))::int`,
    answered: sql<number>`(count(*) filter (where ${tickets.status} = 'answered'))::int`,
    unread: sql<number>`(count(*) filter (where ${hasUnreadReply}))::int`,
  }).from(tickets).where(eq(tickets.userId, userId))
  return counts!
}

export async function customerTicket(db: DbClient, userId: string, id: string) {
  const ticket = await db.query.tickets.findFirst({ where: t => and(eq(t.id, id), eq(t.userId, userId)) })
  if (!ticket) throw new NotFoundError('تیکت یافت نشد.')
  const rows = await db.query.ticketReplies.findMany({ where: t => eq(t.ticketId, id), orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.id)],
    columns: { id: true, body: true, createdAt: true, customerReadAt: true } })
  const replies = rows.map(({ customerReadAt, ...reply }) => ({ ...reply, read: customerReadAt !== null }))
  return { ...ticketToDto({ ...ticket, unread: replies.some(reply => !reply.read) }), replies }
}

export async function readTicketReplies(db: DbClient, userId: string, id: string, replyIds: string[]) {
  const owned = await db.query.tickets.findFirst({ where: t => and(eq(t.id, id), eq(t.userId, userId)), columns: { id: true } })
  if (!owned) throw new NotFoundError('تیکت یافت نشد.')
  await db.update(ticketReplies).set({ customerReadAt: new Date() }).where(and(
    eq(ticketReplies.ticketId, id), inArray(ticketReplies.id, replyIds), isNull(ticketReplies.customerReadAt),
  ))
}

export async function ticketServers(db: DbClient, userId: string) {
  return db.select({ id: servers.id, name: servers.hostname, ip: servers.ipv4, status: servers.status })
    .from(servers).where(and(eq(servers.userId, userId), notInArray(servers.status, ['terminated', 'failed'])))
    .orderBy(servers.createdAt)
}

export async function staffTicketAction(db: DbClient, actorId: string, ticketId: string, input: { requestId: string; reply?: string; close?: boolean }) {
  return db.transaction(async tx => {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for('update')
    if (!ticket) throw new NotFoundError('تیکت یافت نشد')
    const prior = await tx.query.ticketReplies.findFirst({ where: t => eq(t.requestId, input.requestId) })
    if (prior) {
      if (prior.ticketId !== ticket.id || prior.actorId !== actorId || prior.body !== input.reply) throw new ConflictError('کلید درخواست قبلاً استفاده شده است')
      return ticketToDto(ticket)
    }
    if (input.reply) {
      if (ticket.status === 'closed') throw new ConflictError('تیکت بسته شده است')
      const [reply] = await tx.insert(ticketReplies).values({ ticketId, actorId, requestId: input.requestId, body: input.reply }).returning()
      await tx.update(tickets).set({ status: 'answered', updatedAt: new Date() }).where(eq(tickets.id, ticket.id))
      await enqueueSms(tx, 'ticketReplied', ticket.userId, `ticket-reply:${reply!.id}`, { ticketNumber: ticket.id })
      await writeAudit(tx, { actorId, action: 'ticket.replied', targetType: 'ticket', targetId: ticket.id })
    } else if (input.close && ticket.status !== 'closed') {
      await tx.update(tickets).set({ status: 'closed', updatedAt: new Date() }).where(eq(tickets.id, ticket.id))
      await enqueueSms(tx, 'ticketClosed', ticket.userId, `ticket:${ticket.id}:closed`, { ticketNumber: ticket.id })
      await writeAudit(tx, { actorId, action: 'ticket.closed', targetType: 'ticket', targetId: ticket.id })
    }
    const row = await tx.query.tickets.findFirst({ where: t => eq(t.id, ticket.id) })
    return ticketToDto(row!)
  })
}
export async function createSupportTicket(db: DbClient, userId: string, input: {
  title: string; department: string; description?: string; serverId?: string | null
}) {
  return db.transaction(async tx => {
    let snapshot: typeof tickets.$inferInsert.serverSnapshot = null
    if (input.serverId) {
      const [server] = await tx.select().from(servers).where(and(eq(servers.id, input.serverId), eq(servers.userId, userId),
        notInArray(servers.status, ['terminated', 'failed']))).for('share')
      if (!server) throw new NotFoundError('سرور انتخابی دیگر در دسترس حساب شما نیست؛ سرور دیگری یا «سفارشی ندارم» را انتخاب کنید.')
      snapshot = { id: server.id, name: server.hostname, ip: server.ipv4, provider: server.provider }
    }
    const [ticket] = await tx.insert(tickets).values({ userId, title: input.title, department: input.department,
      description: input.description ?? null, serverId: input.serverId ?? null, serverSnapshot: snapshot, status: 'pending' }).returning()
    await writeAudit(tx, { actorId: userId, action: 'ticket.created', targetType: 'ticket', targetId: ticket!.id, metadata: { serverId: input.serverId ?? null } })
    await publishNotification(tx, { userId, eventKey: `ticket:${ticket!.id}:created`, title: 'تیکت ثبت شد',
      body: `تیکت «${ticket!.title}» برای پشتیبانی ثبت شد.`, href: `/tickets?ticket=${ticket!.id}`, type: 'info' })
    await enqueueSms(tx, 'ticketCreated', userId, `ticket:${ticket!.id}:created`, { ticketNumber: ticket!.id })
    return ticketToDto(ticket!)
  })
}
