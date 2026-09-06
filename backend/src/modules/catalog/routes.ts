import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { getOffer, listCatalogProviders, listLocations, listOffers } from './service.js'
import { offerToDto } from '../../lib/dto.js'
import { NotFoundError } from '../../lib/errors.js'

export const registerCatalogRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/catalog/providers', async () => {
    const rows = await listCatalogProviders(db)
    return {
      data: rows.map((p) => ({
        id: p.id,
        name: p.name,
        mode: p.mode,
        enabled: p.enabled,
        healthStatus: p.healthStatus,
        lastSyncAt: p.lastSyncAt?.toISOString() ?? null,
        capabilities: p.capabilities ?? [],
      })),
    }
  })

  app.get('/catalog/locations', async (request) => {
    requireUser(request)
    const query = parse(z.object({ provider: z.string().default('leaseweb') }), request.query)
    const rows = await listLocations(db, query.provider)
    return { data: rows.map((l) => ({ id: l.id, code: l.code, country: l.country, city: l.city })) }
  })

  app.get('/catalog/vps', async (request) => {
    requireUser(request)
    const query = parse(
      z.object({
        provider: z.string().optional(),
        location: z.string().optional(),
        monthlyOnly: z.coerce.boolean().optional(),
      }),
      request.query,
    )
    const rows = await listOffers(db, {
      provider: query.provider ?? 'leaseweb',
      location: query.location,
      monthlyOnly: query.monthlyOnly ?? true,
    })
    const locations = await listLocations(db, query.provider ?? 'leaseweb')
    const codeById = new Map(locations.map((l) => [l.id, l.code]))
    return { data: rows.map((r) => offerToDto(r, codeById.get(r.locationId ?? '') ?? undefined)) }
  })

  app.get('/catalog/vps/:id', async (request) => {
    requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const offer = await getOffer(db, id)
    if (!offer.available) throw new NotFoundError('محصول یافت نشد')
    const loc = offer.locationId ? await db.query.providerLocations.findFirst({ where: (t) => eq(t.id, offer.locationId ?? '') }) : null
    return { data: offerToDto(offer, loc?.code) }
  })
}