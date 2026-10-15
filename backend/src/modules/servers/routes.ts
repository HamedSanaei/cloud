import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { serverToDto } from '../../lib/dto.js'
import { getServerForUser, listServersForUser, recordServerActionAudit, createServerActionOperation } from './service.js'
import { createQuote } from '../quotes/service.js'
import { createOrderFromQuote } from '../orders/service.js'
import { getOffer } from '../catalog/service.js'
import { eq } from 'drizzle-orm'
import { ValidationError } from '../../lib/errors.js'
import { retailBilling } from '../pricing/periods.js'
import type { ProviderBillingOption } from '../providers/provider.interface.js'

const wizardSchema = z.object({
  name: z.string().min(3).max(63),
  offerId: z.string().uuid(),
  os: z.string().min(1),
  walletId: z.string().uuid().optional(),
  billingPeriod: z.enum(['hourly', 'daily', 'monthly']),
}).strict()

export const registerServerRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, queues } = ctx

  app.get('/servers', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listServersForUser(db, user.id, { limit: query.limit ?? 50 })
    return { data: rows.map((s) => serverToDto(s)) }
  })

  app.get('/servers/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const server = await getServerForUser(db, user.id, id)
    return { data: serverToDto(server) }
  })

  // Create server: resolves an offer, quotes, orders, debits the wallet and
  // enqueues provisioning. Returns the server row (or a building placeholder
  // when the server record does not exist yet).
  app.post('/servers', async (request, reply) => {
    const user = requireUser(request)
    const input = parse(wizardSchema, request.body)
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? undefined

    const offer = await getOffer(db, input.offerId)
    const location = offer.locationId ? await db.query.providerLocations.findFirst({ where: (t) => eq(t.id, offer.locationId!) }) : null
    if (!location?.available) throw new ValidationError('موقعیت انتخابی در دسترس نیست')
    const billingOption = retailBilling((offer.billingOptions ?? []) as ProviderBillingOption[], input.billingPeriod).native

    const quote = await createQuote(db, {
      userId: user.id,
      offerId: offer.id,
      locationCode: location.code,
      billingOption,
      billingPeriod: input.billingPeriod,
      operatingSystem: input.os,
    })

    const result = await createOrderFromQuote(db, {
      userId: user.id,
      quoteId: quote.id,
      walletId: input.walletId,
      hostname: input.name ?? '',
      idempotencyKey,
    })

    if (result.created && result.order.status === 'paid') {
      await queues.addProvision(result.order.id)
    }

    // Try to return the server record; it may not exist yet (provisioning
    // still queued) — return a building placeholder then.
    const server = await db.query.servers.findFirst({ where: (t) => eq(t.orderId, result.order.id) })
    if (server) {
      return reply.status(result.created ? 201 : 200).send({ data: serverToDto(server) })
    }
    return reply.status(result.created ? 201 : 200).send({
      data: {
        id: result.order.id,
        name: result.order.hostname,
        status: 'building',
        datacenter: result.order.providerLocation,
        cpu: '',
        ram: '',
        disk: '',
        createdAt: result.order.createdAt.toISOString(),
      },
    })
  })

  // Provider actions — enqueued to the worker, operation tracked + audited.
  app.post('/servers/:id/actions/:action', async (request) => {
    const user = requireUser(request)
    const { id, action } = parse(
      z.object({ id: z.string().uuid(), action: z.enum(['power-on', 'power-off', 'reboot']) }),
      request.params,
    )
    const server = await getServerForUser(db, user.id, id)
    const mapped = action === 'power-on' ? 'power_on' : action === 'power-off' ? 'power_off' : 'reboot'
    const op = await createServerActionOperation(db, server.id, mapped)
    if (!op) throw new Error('failed to create provider operation')
    await queues.addServerAction({ operationId: op.id, serverId: server.id, action: mapped })
    await recordServerActionAudit(db, user.id, server.id, mapped, true)
    return { data: { operationId: op.id, status: 'queued' } }
  })
}
