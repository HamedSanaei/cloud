import { and, eq, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { productSyncRuns, providerLocations, providerProducts, providers } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { getConfig } from '../../config.js'
import { writeAudit } from '../audit/service.js'
import type { CloudProvider } from '../providers/provider.interface.js'

/**
 * Sync a provider's catalog into the normalized tables.
 * The raw provider response is kept on the sync run + product rows for
 * debugging/auditing; application code only consumes normalized rows.
 */
export async function syncProviderCatalog(
  db: DbClient,
  provider: CloudProvider,
  opts: { actorId?: string | null; mode?: 'mock' | 'live' } = {},
) {
  const mode = opts.mode ?? getConfig().LEASEWEB_MODE
  const [run] = await db
    .insert(productSyncRuns)
    .values({ provider: provider.id, mode, status: 'running' })
    .returning()
  if (!run) throw new Error('failed to create sync run')

  try {
    const result = await provider.syncCatalog()

    await db.transaction(async (tx) => {
      // Upsert provider row.
      await tx
        .insert(providers)
        .values({
          id: provider.id,
          name: provider.name,
          mode,
          capabilities: provider.capabilities,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: providers.id,
          set: { name: provider.name, mode, capabilities: provider.capabilities, lastSyncAt: new Date(), updatedAt: new Date() },
        })

      for (const loc of result.locations) {
        await tx
          .insert(providerLocations)
          .values({
            provider: provider.id,
            code: loc.code,
            country: loc.country ?? null,
            city: loc.city ?? null,
          })
          .onConflictDoUpdate({
            target: [providerLocations.provider, providerLocations.code],
            set: { country: loc.country ?? null, city: loc.city ?? null, available: true },
          })
      }

      const locationIdByCode = new Map(
        (
          await tx.query.providerLocations.findMany({
            where: (t) => eq(t.provider, provider.id),
          })
        ).map((l) => [l.code, l.id]),
      )

      for (const offer of result.offers) {
        const locationId = locationIdByCode.get(offer.location) ?? null
        await tx
          .insert(providerProducts)
          .values({
            provider: provider.id,
            providerProductId: offer.providerProductId,
            locationId,
            name: offer.name,
            category: 'vps',
            vcpu: offer.vcpu,
            memoryMb: offer.memoryMb,
            diskGb: offer.diskGb,
            trafficGb: offer.trafficGb ?? null,
            ipv4Count: offer.ipv4Count,
            ipv6Available: offer.ipv6Available,
            billingOptions: offer.billingOptions as never,
            operatingSystems: offer.operatingSystems as never,
            serviceLevels: offer.serviceLevels as never,
            providerCurrency: offer.providerCurrency,
            providerPriceCents: offer.providerPriceCents ?? null,
            available: true,
            enabled: true,
            raw: offer.raw ?? null,
            lastSyncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [providerProducts.provider, providerProducts.providerProductId, providerProducts.locationId],
            set: {
              name: offer.name,
              vcpu: offer.vcpu,
              memoryMb: offer.memoryMb,
              diskGb: offer.diskGb,
              trafficGb: offer.trafficGb ?? null,
              ipv4Count: offer.ipv4Count,
              ipv6Available: offer.ipv6Available,
              billingOptions: offer.billingOptions as never,
              operatingSystems: offer.operatingSystems as never,
              serviceLevels: offer.serviceLevels as never,
              providerCurrency: offer.providerCurrency,
              providerPriceCents: offer.providerPriceCents ?? null,
              available: true,
              raw: offer.raw ?? null,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            },
          })
      }
    })

    const finished = await db
      .update(productSyncRuns)
      .set({
        status: 'success',
        productsSeen: result.offers.length,
        locationsSeen: result.locations.length,
        raw: result.raw as never,
        finishedAt: new Date(),
      })
      .where(eq(productSyncRuns.id, run.id))
      .returning()
    void finished

    await writeAudit(db, {
      actorId: opts.actorId ?? null,
      action: 'provider.catalog_synced',
      targetType: 'provider',
      targetId: run.id,
      metadata: { provider: provider.id, offers: result.offers.length, locations: result.locations.length },
    })
    return { runId: run.id, products: result.offers.length, locations: result.locations.length }
  } catch (err) {
    await db
      .update(productSyncRuns)
      .set({ status: 'failed', error: (err as Error).message, finishedAt: new Date() })
      .where(eq(productSyncRuns.id, run.id))
    throw err
  }
}

export async function getProviderRow(db: DbClient, providerId: string) {
  const row = await db.query.providers.findFirst({ where: (t) => eq(t.id, providerId) })
  if (!row) throw new NotFoundError(`Provider '${providerId}' not found`)
  return row
}

export async function listCatalogProviders(db: DbClient) {
  return db.query.providers.findMany({ orderBy: (t) => t.id })
}

export async function listLocations(db: DbClient, providerId: string) {
  return db.query.providerLocations.findMany({
    where: (t) => and(eq(t.provider, providerId), eq(t.available, true)),
    orderBy: (t) => t.code,
  })
}

export async function listOffers(
  db: DbClient,
  opts: { provider?: string; location?: string; monthlyOnly?: boolean; enabledOnly?: boolean } = {},
) {
  const rows = await db.query.providerProducts.findMany({
    where: (t, { and, eq }) =>
      and(
        opts.provider ? eq(t.provider, opts.provider) : undefined,
        opts.location ? eq(t.locationId, sql`(select id from provider_locations where provider = ${t.provider} and code = ${opts.location} limit 1)`) : undefined,
        opts.enabledOnly === false ? undefined : eq(t.enabled, true),
        eq(t.available, true),
      ),
    orderBy: (t, { asc }) => [asc(t.providerProductId)],
  })
  let out = rows
  if (opts.monthlyOnly) {
    out = rows.filter((r) => {
      const opts2 = r.billingOptions as Array<{ monthly?: boolean }> | null
      return Array.isArray(opts2) && opts2.some((b) => b.monthly)
    })
  }
  return out
}

export async function getOffer(db: DbClient, offerId: string) {
  const row = await db.query.providerProducts.findFirst({ where: (t) => eq(t.id, offerId) })
  if (!row) throw new NotFoundError('محصول یافت نشد')
  return row
}

export async function setOfferEnabled(db: DbClient, offerId: string, enabled: boolean, actorId?: string) {
  const row = await db.query.providerProducts.findFirst({ where: (t) => eq(t.id, offerId) })
  if (!row) throw new NotFoundError('محصول یافت نشد')
  await db.update(providerProducts).set({ enabled }).where(eq(providerProducts.id, offerId))
  await writeAudit(db, {
    actorId: actorId ?? null,
    action: enabled ? 'admin.product_enabled' : 'admin.product_disabled',
    targetType: 'provider_product',
    targetId: offerId,
  })
}

export async function setLocationAvailability(db: DbClient, providerId: string, code: string, available: boolean, actorId?: string) {
  const row = await db.query.providerLocations.findFirst({
    where: (t) => and(eq(t.provider, providerId), eq(t.code, code)),
  })
  if (!row) throw new NotFoundError('موقعیت یافت نشد')
  await db.update(providerLocations).set({ available }).where(eq(providerLocations.id, row.id))
  await writeAudit(db, {
    actorId: actorId ?? null,
    action: available ? 'admin.location_enabled' : 'admin.location_disabled',
    targetType: 'provider_location',
    targetId: row.id,
  })
}

export async function listSyncRuns(db: DbClient, providerId: string, limit = 20) {
  return db.query.productSyncRuns.findMany({
    where: (t) => eq(t.provider, providerId),
    orderBy: (t, { desc }) => [desc(t.startedAt)],
    limit,
  })
}

export async function setProviderHealth(db: DbClient, providerId: string, status: string) {
  await db.update(providers).set({ healthStatus: status }).where(eq(providers.id, providerId))
}

export async function latestSyncRun(db: DbClient, providerId: string) {
  return db.query.productSyncRuns.findFirst({
    where: (t) => eq(t.provider, providerId),
    orderBy: (t, { desc }) => [desc(t.startedAt)],
  })
}

export async function findOfferByProductAndLocation(db: DbClient, provider: string, productId: string, locationCode: string) {
  const rows = await db.query.providerProducts.findMany({
    where: (t, { and, eq }) =>
      and(
        eq(t.provider, provider),
        eq(t.providerProductId, productId),
        eq(
          t.locationId,
          sql`(select id from provider_locations where provider = ${provider} and code = ${locationCode} limit 1)`,
        ),
      ),
    limit: 1,
  })
  return rows[0] ?? null
}