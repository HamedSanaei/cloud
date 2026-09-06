import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { cancelSubscription, getSubscription, listSubscriptions, setAutoRenew } from './service.js'
import { subscriptionToDto } from '../../lib/dto.js'

export const registerSubscriptionRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/subscriptions', async (request) => {
    const user = requireUser(request)
    const rows = await listSubscriptions(db, user.id)
    return { data: rows.map(subscriptionToDto) }
  })

  app.get('/subscriptions/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const sub = await getSubscription(db, user.id, id)
    return { data: subscriptionToDto(sub) }
  })

  app.patch('/subscriptions/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const input = parse(z.object({ autoRenew: z.boolean() }), request.body)
    const sub = await setAutoRenew(db, user.id, id, input.autoRenew)
    return { data: subscriptionToDto(sub) }
  })

  app.post('/subscriptions/:id/cancel', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const sub = await cancelSubscription(db, user.id, id)
    return { data: subscriptionToDto(sub) }
  })
}