import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { iranRateMaximum, type PublicHetznerOffer, type PublicTariffMeta } from '../../contracts/home-tariffs.js'
import { AppError } from '../../lib/errors.js'
import { createLogger } from '../../logger.js'
import { getStorefront } from './storefront.js'
import { isSiteAuthority } from '../integration/authority.js'

export const iranTariffsKey = 'catalog.iran_monthly_tariffs'
const rate = z.number().int().nonnegative().max(iranRateMaximum).nullable()
export const iranTariffsSchema = z.object({
  rates: z.object({ outbound: rate, inbound: rate, cpu: rate, ram: rate }).strict(),
  trafficUnit: z.enum(['TB', 'TiB']), tax: z.enum(['included', 'excluded']), published: z.boolean(),
}).strict().refine(value => !value.published || Object.values(value.rates).some(rate => rate !== null), 'برای انتشار دست‌کم یک نرخ مصوب ثبت کنید.')

export async function iranTariffSettings(db: DbClient) {
  const row = await db.query.settings.findFirst({ where: t => eq(t.key, iranTariffsKey) })
  return iranTariffsSchema.safeParse(row?.value).data ?? null
}

export function publicHetznerOffers(catalog: Awaited<ReturnType<typeof getStorefront>>): PublicHetznerOffer[] {
  return catalog.offers.filter(offer => offer.provider === 'hetzner').flatMap(offer => {
    const hourly = offer.prices.find(price => price.period === 'hourly')?.totalRial ?? null
    const monthly = offer.prices.find(price => price.period === 'monthly')?.totalRial ?? null
    if (hourly === null && monthly === null) return []
    return [{ id: offer.id, name: offer.name, location: offer.location, country: offer.country, city: offer.city, vcpu: offer.vcpu, memoryMb: offer.memoryMb,
      diskGb: offer.diskGb, diskType: offer.diskType, trafficGb: offer.trafficGb, hourly, monthly }]
  })
}

export async function getHomeTariffs(db: DbClient) {
  // The linked platform catalog requires an authenticated customer token.
  const [iran, hetzner] = await Promise.allSettled([
    iranTariffSettings(db), isSiteAuthority() ? getStorefront(db, false, 'hetzner') : Promise.resolve(null),
  ])
  const published = iran.status === 'fulfilled' && iran.value?.published ? iran.value : null
  const now = new Date().toISOString()
  let meta: PublicTariffMeta = { checkedAt: now, validUntil: now, status: 'temporarily_unavailable', catalogUpdatedAt: null, fxUpdatedAt: null }
  if (hetzner.status === 'fulfilled') meta = hetzner.value
    ? { ...hetzner.value.freshness, status: hetzner.value.offers.length ? 'available' : 'unavailable' }
    : { ...meta, status: 'not_published' }
  else {
    const code = hetzner.reason instanceof AppError ? hetzner.reason.code : 'catalog_unavailable'
    // No raw error/provider response/credentials/wholesale data in public HTML or logs.
    createLogger('public-pricing').warn({ code }, 'Public Hetzner pricing unavailable')
    if (['fx_rate_stale', 'not_found', 'usdt_rate_unavailable', 'eur_rate_unavailable'].includes(code)) meta.status = 'pricing_unavailable'
  }
  return {
    iran: published ? { rates: published.rates, trafficUnit: published.trafficUnit, tax: published.tax } : null,
    hetzner: hetzner.status === 'fulfilled' ? hetzner.value ? publicHetznerOffers(hetzner.value) : [] : null,
    meta,
  }
}
