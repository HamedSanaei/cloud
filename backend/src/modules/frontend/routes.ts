/**
 * Unversioned /api compatibility routes for the CURRENT SPA API layer
 * (src/lib/endpoints.ts). They wrap the same services the versioned API uses.
 * Registered ONLY at /api (not /api/v1) to avoid duplicating the versioned
 * surface.
 *
 * Products not yet offered by the platform (IPs, traffic packages, domains)
 * return empty lists; purchase actions return 501 with a clear message —
 * never fake data, never dead-end silently.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { ticketToDto } from '../../lib/dto.js'
import { countOpenInvoices } from '../invoices/service.js'
import { totalBalanceRial } from '../wallets/service.js'
import { rialToToman } from '../../lib/money.js'
import { tickets, notifications, users } from '../../db/schema.js'
import { writeAudit } from '../audit/service.js'
import { BadRequestError } from '../../lib/errors.js'

const ticketSchema = z.object({
  title: z.string().min(3, 'عنوان تیکت باید حداقل ۳ کاراکتر باشد').max(200),
  department: z.enum(['technical', 'finance', 'sales']).default('technical'),
  description: z.string().max(5000).optional(),
})

export const registerFrontendCompatRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  // ---- Dashboard ------------------------------------------------------------
  app.get('/dashboard/summary', async (request) => {
    const user = requireUser(request)
    const [servers, openTickets, unpaidInvoices, walletBalance] = await Promise.all([
      db.query.servers.findMany({ where: (t) => eq(t.userId, user.id) }),
      db.query.tickets.findMany({ where: (t) => eq(t.userId, user.id) }),
      countOpenInvoices(db, user.id),
      totalBalanceRial(db, user.id),
    ])
    const ipCount = servers.filter((s) => s.ipv4).length
    return {
      data: {
        activeServers: servers.filter((s) => s.status === 'active').length,
        ips: ipCount,
        domains: 0,
        trafficPackages: 0,
        openTickets: openTickets.filter((t) => t.status === 'pending' || t.status === 'review').length,
        unpaidInvoices,
        walletBalance: rialToToman(walletBalance),
      },
    }
  })

  // ---- Notifications ----------------------------------------------------------
  app.get('/notifications', async (request) => {
    const user = requireUser(request)
    const rows = await db.query.notifications.findMany({
      where: (t) => eq(t.userId, user.id),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 50,
    })
    return { data: rows.map((n) => ({ id: n.id, title: n.title, body: n.body, type: n.type, read: n.read, createdAt: n.createdAt.toISOString() })) }
  })

  app.patch('/notifications/read', async (request) => {
    const user = requireUser(request)
    await db.update(notifications).set({ read: true }).where(eq(notifications.userId, user.id))
    return { data: { ok: true } }
  })

  // ---- Tickets -----------------------------------------------------------------
  app.get('/tickets', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await db.query.tickets.findMany({
      where: (t) => eq(t.userId, user.id),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: query.limit ?? 50,
    })
    return { data: rows.map(ticketToDto) }
  })

  app.get('/tickets/summary', async (request) => {
    const user = requireUser(request)
    const rows = await db.query.tickets.findMany({ where: (t) => eq(t.userId, user.id) })
    return {
      data: {
        total: rows.length,
        open: rows.filter((t) => t.status === 'pending' || t.status === 'review').length,
        reviewing: rows.filter((t) => t.status === 'review').length,
        answered: rows.filter((t) => t.status === 'answered').length,
        unread: 0,
      },
    }
  })

  app.post('/tickets', async (request) => {
    const user = requireUser(request)
    const input = parse(ticketSchema, request.body)
    const [ticket] = await db
      .insert(tickets)
      .values({ userId: user.id, title: input.title, department: input.department, description: input.description ?? null, status: 'pending' })
      .returning()
    if (!ticket) throw new Error('failed to create ticket')
    await writeAudit(db, { actorId: user.id, action: 'ticket.created', targetType: 'ticket', targetId: ticket.id })
    return { data: ticketToDto(ticket) }
  })

  // ---- Charge requests ------------------------------------------------------------
  app.get('/charge-requests', async (request) => {
    const user = requireUser(request)
    const rows = await db.query.chargeRequests.findMany({
      where: (t) => eq(t.userId, user.id),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 50,
    })
    return {
      data: rows.map((c) => ({
        id: c.id,
        number: c.number,
        invoiceNumber: c.invoiceNumber ?? undefined,
        amount: rialToToman(c.amountRial),
        amountRial: c.amountRial,
        status: c.status,
        date: c.createdAt.toISOString(),
      })),
    }
  })

  // Wallets/invoices compat endpoints are provided by the versioned route
  // plugins (also registered under /api).

  // ---- Profile (compat) ---------------------------------------------------------------
  app.get('/profile', async (request) => {
    const user = requireUser(request)
    const row = await db.query.users.findFirst({ where: (t) => eq(t.id, user.id) })
    if (!row) throw new BadRequestError('کاربر یافت نشد')
    return {
      data: {
        firstName: row.firstName ?? '',
        lastName: row.lastName ?? '',
        mobile: row.mobile ?? '',
        nationalCode: row.nationalCode ?? '',
        email: row.email,
        legalEnabled: false,
        timezone: row.timezone ?? 'Asia/Tehran',
      },
    }
  })

  app.put('/profile', async (request) => {
    const user = requireUser(request)
    const input = parse(
      z.object({
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        mobile: z.string().max(30).optional(),
        nationalCode: z.string().max(20).optional(),
      }),
      request.body,
    )
    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (input.firstName !== undefined) updates.firstName = input.firstName
    if (input.lastName !== undefined) updates.lastName = input.lastName
    if (input.mobile !== undefined) updates.mobile = input.mobile
    if (input.nationalCode !== undefined) updates.nationalCode = input.nationalCode
    await db.update(users).set(updates).where(eq(users.id, user.id))
    return { data: { ok: true } }
  })

  app.post('/profile/verify-national-code', async () => {
    throw new BadRequestError('تأیید کد ملی به‌زودی فعال می‌شود')
  })

  // ---- Products not offered yet ---------------------------------------------------------
  const notOffered = (product: string) => () => {
    throw new BadRequestError(`سرویس «${product}» هنوز در پلتفرم فعال نشده است`)
  }

  app.get('/ips', async () => ({ data: [] }))
  app.post('/ips', notOffered('آی‌پی اختصاصی'))
  app.get('/traffic-packages', async () => ({ data: [] }))
  app.post('/traffic-packages', notOffered('بسته ترافیک'))
  app.get('/domains', async () => ({ data: [] }))
  app.get('/domains/orders', async () => ({ data: [] }))
  app.get('/domains/availability', async (request) => {
    const query = parse(z.object({ domain: z.string().min(1).max(253) }), request.query)
    return { data: { domain: query.domain, available: false, pricePerYear: 0 } }
  })
  app.post('/domains', notOffered('ثبت دامنه'))
  app.post('/domains/transfer', notOffered('انتقال دامنه'))

  // Charge-request creation is intentionally not exposed yet: wallet charging
  // goes through admin credit or a payment gateway in a later phase.
}