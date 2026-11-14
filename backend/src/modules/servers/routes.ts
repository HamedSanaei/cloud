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
import { loadFundingFleet, serverPowerPolicy } from '../billing/funding.js'
import { pendingProvisioningRows, provisioningRow } from './provisioning.js'
import { registerCustomerServerRoutes } from './customer-routes.js'
import { registerServerConsole } from './console.js'

const wizardSchema = z.object({
  name: z.string().min(3).max(63),
  offerId: z.string().uuid(),
  os: z.string().min(1),
  walletId: z.string().uuid().optional(),
  billingPeriod: z.enum(['hourly', 'daily', 'monthly']),
}).strict()

export const registerServerRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, queues } = ctx
  await app.register(registerCustomerServerRoutes, { ctx })
  await app.register(registerServerConsole, { ctx })

  app.get('/servers', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listServersForUser(db, user.id, { limit: query.limit ?? 50 })
    const fleet = await loadFundingFleet(db, user.id)
    const pending = await pendingProvisioningRows(db, user.id, query.limit ?? 50)
    return { data: [...pending, ...rows.map((server) => serverToDto(server, serverPowerPolicy(server, fleet)))] }
  })

  app.get('/servers/provisioning/:orderId', async request => {
    const user = requireUser(request)
    const { orderId } = parse(z.object({ orderId: z.string().uuid() }), request.params)
    return { data: await provisioningRow(db, user.id, orderId) }
  })
  // Platform-mode middleware handles this route with the authenticated linked token.
  app.get('/servers/provisioning/platform/:id', async request => {
    requireUser(request)
    throw new ValidationError('این درخواست متعلق به سرویس مشترک است؛ اتصال پلتفرم فعال نیست')
  })

  app.get('/servers/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const server = await getServerForUser(db, user.id, id)
    return { data: serverToDto(server, serverPowerPolicy(server, await loadFundingFleet(db, user.id))) }
  })

  // Create server: resolves an offer, quotes, orders, debits the wallet and
  // enqueues provisioning. Returns the server row (or a building placeholder
  // when the server record does not exist yet).
  app.post('/servers', async (request, reply) => {
    const user = requireUser(request)
    const input = parse(wizardSchema, request.body)
    const idempotencyKey = parse(z.string().min(1).max(200).optional(), request.headers['idempotency-key'])

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
      payFromWallet: true,
      hostname: input.name ?? '',
      idempotencyKey,
    })

    if (result.order.status === 'paid') {
      await queues.addProvision(result.order.id)
    }

    return reply.status(result.created ? 201 : 200).send({ data: await provisioningRow(db, user.id, result.order.id) })
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
    if (server.provider === 'hetzner' && action === 'power-off') {
      const confirmation = parse(z.object({ confirm: z.literal(true), hostname: z.string() }).strict(), request.body)
      if (confirmation.hostname !== server.hostname) throw new ValidationError('نام سرور برای تأیید خاموشی اجباری مطابقت ندارد')
    }
    const op = await createServerActionOperation(db, server.id, mapped)
    await queues.addServerAction({ operationId: op.id, serverId: server.id, action: mapped })
    await recordServerActionAudit(db, user.id, server.id, mapped, true)
    return { data: { operationId: op.id, status: 'queued' } }
  })
}
