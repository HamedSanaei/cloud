import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { serverToDto } from '../../lib/dto.js'
import { getServerForUser, listServersForUser, recordServerActionAudit, createServerActionOperation } from './service.js'
import { createQuote } from '../quotes/service.js'
import { createOrderFromQuote } from '../orders/service.js'
import { findOfferByProductAndLocation, getOffer } from '../catalog/service.js'
import { eq } from 'drizzle-orm'
import { NotFoundError, ValidationError } from '../../lib/errors.js'

// Wizard-style payload from the current SPA (region/plan/os), or the clean
// versioned payload (offerId).
const wizardSchema = z.object({
  name: z.string().max(63).optional(),
  region: z.string().optional(),
  plan: z.string().optional(),
  os: z.string().optional(),
  walletId: z.string().uuid().optional(),
  billingPeriod: z.string().optional(),
  offerId: z.string().uuid().optional(),
})

const PLAN_TIERS: Record<string, string> = {
  starter: 'VPS02_1', // 2 vCPU / 1 GB
  standard: 'VPS02_4', // 2 vCPU / 4 GB
  pro: 'VPS04_8', // 4 vCPU / 8 GB
}

const REGION_MAP: Record<string, string> = {
  germany: 'FRA-01',
  tehran: 'AMS-01', // no Iran DC exists — nearest demo location
  turkey: 'AMS-01',
}

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

    const offer = await resolveOffer(db, input)
    const billingOption = pickMonthlyBillingOption(offer)
    const os = resolveOs(input.os)

    const quote = await createQuote(db, {
      userId: user.id,
      offerId: offer.id,
      locationCode: offer.locationCode,
      billingOption,
      operatingSystem: os,
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

async function resolveOffer(db: AppContext['db'], input: z.infer<typeof wizardSchema>) {
  if (input.offerId) {
    const offer = await getOffer(db, input.offerId)
    if (!offer.enabled || !offer.available) throw new ValidationError('این محصول فعلاً قابل سفارش نیست')
    const loc = offer.locationId ? await db.query.providerLocations.findFirst({ where: (t) => eq(t.id, offer.locationId ?? '') }) : null
    return { ...offer, locationCode: loc?.code ?? '' }
  }

  const productId = input.plan ? PLAN_TIERS[input.plan] : undefined
  const locationCode = input.region ? REGION_MAP[input.region] : undefined
  if (!productId) throw new ValidationError('پلن انتخابی نامعتبر است (starter | standard | pro)')

  const offer =
    (locationCode ? await findOfferByProductAndLocation(db, 'leaseweb', productId, locationCode) : null) ??
    (await findOfferByProductAndLocation(db, 'leaseweb', productId, 'FRA-01')) ??
    (await db.query.providerProducts.findFirst({ where: (t) => eq(t.providerProductId, productId) }))

  if (!offer) throw new NotFoundError('محصول انتخابی یافت نشد — ابتدا کاتالوگ سرویس‌دهنده را همگام‌سازی کنید')
  const loc = offer.locationId ? await db.query.providerLocations.findFirst({ where: (t) => eq(t.id, offer.locationId ?? '') }) : null
  return { ...offer, locationCode: loc?.code ?? 'FRA-01' }
}

/** Pick the plain monthly option (no commitment) from the stored offer. */
function pickMonthlyBillingOption(offer: { billingOptions: unknown }) {
  const options = (offer.billingOptions ?? []) as Array<{
    billingCycle: string
    contractTerm?: number | string
    monthly?: boolean
    label?: string
    amountCents: number
  }>
  const monthly =
    options.find((o) => o.monthly && (o.contractTerm === 0 || o.contractTerm === undefined)) ??
    options.find((o) => o.monthly) ??
    options[0]
  if (!monthly) throw new ValidationError('این محصول گزینه پرداخت ماهانه ندارد')
  return {
    billingCycle: monthly.billingCycle,
    label: monthly.label,
    contractTerm: monthly.contractTerm ?? 0,
    periodMonths: 1,
    amountCents: monthly.amountCents,
    monthly: true,
  }
}

function resolveOs(os: string | undefined): string {
  if (!os) return 'ubuntu-24.04'
  const key = os.toLowerCase()
  if (key.includes('ubuntu')) return 'ubuntu-24.04'
  if (key.includes('debian')) return 'debian-12'
  if (key.includes('centos')) return 'centos-stream-9'
  if (key.includes('rocky')) return 'rocky-9'
  return os
}