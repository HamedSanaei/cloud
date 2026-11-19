/**
 * Unversioned /api compatibility routes for the CURRENT SPA API layer
 * (src/lib/endpoints.ts). They wrap the same services the versioned API uses.
 * Registered ONLY at /api (not /api/v1) to avoid duplicating the versioned
 * surface.
 *
 * Products not yet offered by the platform (IPs, traffic packages, domains)
 * return empty lists; purchase actions are rejected with a clear message —
 * never fake data, never dead-end silently.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { chargeRequests, walletPayments } from '../../db/schema.js'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { ticketToDto } from '../../lib/dto.js'
import { countOpenInvoices } from '../invoices/service.js'
import { totalBalanceRial } from '../wallets/service.js'
import { rialToToman } from '../../lib/money.js'
import { listNotifications, readNotifications } from '../notifications/service.js'
import { BadRequestError } from '../../lib/errors.js'
import { NotFoundError } from '../../lib/errors.js'
import { createSupportTicket, ticketServers } from '../tickets/service.js'

const ticketSchema = z.object({
  title: z.string().min(3, 'عنوان تیکت باید حداقل ۳ کاراکتر باشد').max(200),
  department: z.enum(['technical', 'finance', 'sales']).default('technical'),
  description: z.string().max(5000).optional(),
  serverId: z.string().uuid().nullable().optional(),
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
  app.get('/notifications', async (request, reply) => {
    const user = requireUser(request)
    reply.header('Cache-Control', 'no-store')
    return { data: await listNotifications(db, user.id) }
  })

  app.patch('/notifications/read', async (request) => {
    const user = requireUser(request)
    const input = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).optional(), request.body)
    await readNotifications(db, user.id, input?.ids)
    return { data: { ok: true } }
  })

  // ---- Tickets -----------------------------------------------------------------
  app.get('/tickets/servers', async request => ({ data: await ticketServers(db, requireUser(request).id) }))
  app.get('/tickets/:id', async request => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const ticket = await db.query.tickets.findFirst({ where: t => eq(t.id, id) })
    if (!ticket || ticket.userId !== user.id) throw new NotFoundError('تیکت یافت نشد.')
    const replies = await db.query.ticketReplies.findMany({ where: t => eq(t.ticketId, id), orderBy: (t, { asc }) => [asc(t.createdAt)], columns: { id: true, body: true, createdAt: true } })
    return { data: { ...ticketToDto(ticket), replies } }
  })
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
    return { data: await createSupportTicket(db, user.id, input) }
  })

  // ---- Charge requests ------------------------------------------------------------
  const chargesForUser = async (userId: string, id?: string) => {
    const rows = await db.select({ charge: chargeRequests, paymentId: walletPayments.id, paymentStatus: walletPayments.status,
      providerReference: walletPayments.providerReference }).from(chargeRequests)
      .leftJoin(walletPayments, and(eq(walletPayments.chargeRequestId, chargeRequests.id), eq(walletPayments.userId, userId)))
      .where(and(eq(chargeRequests.userId, userId), id ? eq(chargeRequests.id, id) : undefined))
      .orderBy(desc(chargeRequests.createdAt)).limit(id ? 1 : 50)
    return rows.map(({ charge: c, paymentId, paymentStatus, providerReference }) => {
      const historicalReference = /^\d+$/.test(c.invoiceNumber ?? '') ? c.invoiceNumber : undefined
      return {
        id: c.id,
        number: c.number,
        invoiceNumber: historicalReference ? undefined : c.invoiceNumber ?? undefined,
        paymentReference: providerReference ?? historicalReference,
        paymentId: paymentId ?? undefined,
        paymentStatus: paymentStatus ?? undefined,
        amount: rialToToman(c.amountRial),
        amountRial: c.amountRial,
        status: c.status,
        date: c.createdAt.toISOString(),
      }
    })
  }
  app.get('/charge-requests', async request => ({ data: await chargesForUser(requireUser(request).id) }))
  app.get('/charge-requests/:id', async (request, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params)
    const [charge] = await chargesForUser(requireUser(request).id, id)
    if (!charge) throw new NotFoundError('درخواست شارژ یافت نشد.')
    return reply.header('Cache-Control', 'private, no-store').send({ data: charge })
  })

  // Wallets/invoices compat endpoints are provided by the versioned route
  // plugins (also registered under /api).

  app.post('/profile/verify-national-code', async () => {
    throw new BadRequestError('تأیید کد ملی به‌زودی فعال می‌شود')
  })

  // ---- Products not offered yet ---------------------------------------------------------
  const unavailableReason = (product: string) => `سرویس «${product}» هنوز در پلتفرم فعال نشده است`
  const notOffered = (product: string) => () => {
    throw new BadRequestError(unavailableReason(product))
  }

  app.get('/infrastructure/capabilities', async (request, reply) => {
    requireUser(request)
    reply.header('Cache-Control', 'no-store')
    // These independent purchase handlers are not implemented in either
    // authority mode. Enable a capability only alongside its real service.
    return { data: {
      ips: { enabled: false, reason: unavailableReason('آی‌پی اختصاصی') },
      trafficPackages: { enabled: false, reason: unavailableReason('بسته ترافیک') },
    } }
  })

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

  // Site wallet recharge and issuer verification live in the payment routes.
}
