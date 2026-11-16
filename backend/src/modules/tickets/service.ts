import { enqueueSms } from '../notifications/sms.js'
import { and, eq, notInArray } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { servers, tickets, ticketReplies } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { ticketToDto } from '../../lib/dto.js'
import { publishNotification } from '../notifications/service.js'

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
