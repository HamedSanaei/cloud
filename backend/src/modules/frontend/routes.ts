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
import { and, desc, eq, sql } from 'drizzle-orm'
import { chargeRequests, walletPayments } from '../../db/schema.js'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { countOpenInvoices } from '../invoices/service.js'
import { totalBalanceRial } from '../wallets/service.js'
import { rialToToman } from '../../lib/money.js'
import { listNotifications, readNotifications } from '../notifications/service.js'
import { BadRequestError } from '../../lib/errors.js'
import { NotFoundError } from '../../lib/errors.js'
import { createSupportTicket, customerTicket, customerTicketSummary, listCustomerTickets, readTicketReplies, ticketServers } from '../tickets/service.js'
import { containsSearch, historyPage, historyQuery } from '../../lib/list-search.js'
import { listServerAddresses } from '../servers/service.js'

const chargeQuery = historyQuery.extend({ status: z.enum(['all', 'pending', 'approved', 'rejected', 'processing']).default('all') })

const ticketSchema = z.object({
  title: z.string().min(3, 'عنوان تیکت باید حداقل ۳ کاراکتر باشد').max(200),
  department: z.enum(['technical', 'finance', 'sales']).default('technical'),
  description: z.string().max(5000).optional(),
  serverId: z.string().uuid().nullable().optional(),
})
const ticketQuery = historyQuery.extend({
  status: z.enum(['all', 'pending', 'review', 'answered', 'closed']).default('all'),
  department: z.enum(['all', 'technical', 'finance', 'sales']).default('all'),
})

export const registerFrontendCompatRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  // ---- Dashboard ------------------------------------------------------------
  app.get('/dashboard/summary', async (request) => {
    const user = requireUser(request)
    const [servers, ipAddresses, ticketCounts, unpaidInvoices, walletBalance] = await Promise.all([
      db.query.servers.findMany({ where: (t) => eq(t.userId, user.id) }),
      listServerAddresses(db, user.id),
      customerTicketSummary(db, user.id),
      countOpenInvoices(db, user.id),
      totalBalanceRial(db, user.id),
    ])
    return {
      data: {
        activeServers: servers.filter((s) => s.status === 'active').length,
        ips: ipAddresses.length,
        domains: 0,
        trafficPackages: 0,
        openTickets: ticketCounts.open,
        unpaidInvoices,
        walletBalance: rialToToman(walletBalance),
      },
    }
  })

  // ---- Notifications ----------------------------------------------------------
  app.get('/notifications', async (request, reply) => {
    const user = requireUser(request)
    reply.header('Cache-Control', 'no-store')
    return listNotifications(db, user.id)
  })

  app.patch('/notifications/read', async (request) => {
    const user = requireUser(request)
    const input = parse(z.union([
      z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
      z.object({ all: z.literal(true) }).strict(),
    ]).optional(), request.body)
    await readNotifications(db, user.id, input && 'ids' in input ? input.ids : undefined)
    return { data: { ok: true } }
  })

  // ---- Tickets -----------------------------------------------------------------
  app.get('/tickets/servers', async request => ({ data: await ticketServers(db, requireUser(request).id) }))
  app.get('/tickets/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    reply.header('Cache-Control', 'private, no-store')
    return { data: await customerTicket(db, user.id, id) }
  })
  app.post('/tickets/:id/read', async request => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const { replyIds } = parse(z.object({ replyIds: z.array(z.uuid()).min(1).max(200) }).strict(), request.body)
    await readTicketReplies(db, user.id, id, replyIds)
    return { data: { ok: true } }
  })
  app.get('/tickets', async (request) => {
    const user = requireUser(request)
    const query = parse(ticketQuery, request.query)
    const rows = await listCustomerTickets(db, user.id, { ...query, limit: query.limit + 1 })
    return historyPage(rows, query.limit, query.offset)
  })

  app.get('/tickets/summary', async (request) => {
    const user = requireUser(request)
    return { data: await customerTicketSummary(db, user.id) }
  })

  app.post('/tickets', async (request) => {
    const user = requireUser(request)
    const input = parse(ticketSchema, request.body)
    return { data: await createSupportTicket(db, user.id, input) }
  })

  // ---- Charge requests ------------------------------------------------------------
  const chargesForUser = async (userId: string, id?: string, query?: z.infer<typeof chargeQuery>) => {
    const rows = await db.select({ charge: chargeRequests, paymentId: walletPayments.id, paymentStatus: walletPayments.status,
      providerReference: walletPayments.providerReference }).from(chargeRequests)
      .leftJoin(walletPayments, and(eq(walletPayments.chargeRequestId, chargeRequests.id), eq(walletPayments.userId, userId)))
      .where(and(eq(chargeRequests.userId, userId), id ? eq(chargeRequests.id, id) : undefined,
        query && query.status !== 'all' ? eq(chargeRequests.status, query.status) : undefined,
        query?.search ? containsSearch(sql`concat_ws(' ', ${chargeRequests.number}, ${chargeRequests.invoiceNumber}, ${walletPayments.providerReference})`, query.search) : undefined))
      .orderBy(desc(chargeRequests.createdAt), desc(chargeRequests.id)).limit(query ? query.limit + 1 : 1).offset(query?.offset ?? 0)
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
  app.get('/charge-requests', async request => {
    const user = requireUser(request)
    const query = parse(chargeQuery, request.query)
    return historyPage(await chargesForUser(user.id, undefined, query), query.limit, query.offset)
  })
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

  app.get('/ips', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return { data: await listServerAddresses(db, requireUser(request).id) }
  })
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
