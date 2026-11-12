import { and, eq, notInArray } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { servers, tickets } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { ticketToDto } from '../../lib/dto.js'

export async function ticketServers(db: DbClient, userId: string) {
  return db.select({ id: servers.id, name: servers.hostname, ip: servers.ipv4, status: servers.status })
    .from(servers).where(and(eq(servers.userId, userId), notInArray(servers.status, ['terminated', 'failed'])))
    .orderBy(servers.createdAt)
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
    return ticketToDto(ticket!)
  })
}
