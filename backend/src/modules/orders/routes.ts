import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { cancelUnpaidOrder, createOrderFromQuote, getOrder, listOrders, payOrder } from './service.js'
import { orderToDto } from '../../lib/dto.js'

const createOrderSchema = z.object({
  quoteId: z.string().uuid(),
  walletId: z.string().uuid().optional(),
  hostname: z.string().max(63).optional(),
})

const paySchema = z.object({
  walletId: z.string().uuid(),
})

export const registerOrderRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, queues } = ctx

  app.post('/orders', async (request, reply) => {
    const user = requireUser(request)
    const input = parse(createOrderSchema, request.body)
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? undefined

    const result = await createOrderFromQuote(db, {
      userId: user.id,
      quoteId: input.quoteId,
      walletId: input.walletId,
      hostname: input.hostname ?? '',
      idempotencyKey,
    })

    // Enqueue provisioning only after the DB transaction committed and only
    // for freshly paid orders (idempotent replay returns the existing order).
    if (result.created && result.order.status === 'paid') {
      await queues.addProvision(result.order.id)
    }

    return reply.status(result.created ? 201 : 200).send({ data: orderToDto(result.order) })
  })

  app.get('/orders', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listOrders(db, user.id, { limit: query.limit ?? 50 })
    return { data: rows.map(orderToDto) }
  })

  app.get('/orders/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const order = await getOrder(db, user.id, id)
    return {
      data: {
        ...orderToDto(order),
        items: order.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          description: i.description,
          quantity: i.quantity,
          totalRial: i.totalRial,
        })),
        events: order.events.map((e) => ({
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          reason: e.reason,
          createdAt: e.createdAt.toISOString(),
        })),
      },
    }
  })

  app.post('/orders/:id/pay', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const input = parse(paySchema, request.body)
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? undefined
    const order = await payOrder(db, { userId: user.id, orderId: id, walletId: input.walletId, idempotencyKey })
    await queues.addProvision(order.id)
    return { data: orderToDto(order) }
  })

  app.post('/orders/:id/cancel', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    await cancelUnpaidOrder(db, { userId: user.id, orderId: id })
    return { data: { ok: true } }
  })
}