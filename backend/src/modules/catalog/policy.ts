import { isActiveAdmin } from '../../contracts/account-role.js'
import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { providers } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { AppError, ForbiddenError, ValidationError } from '../../lib/errors.js'
import { getProvider, listProviders } from '../providers/registry.js'

function providerConfig(providerId: string) {
  const configured = getConfig().PROVIDERS
  return providerId === 'hetzner' ? configured.hetzner : providerId === 'leaseweb' ? configured.leaseweb : null
}

export function providerOrderingConfigured(providerId: string) {
  const options = providerConfig(providerId)
  return !!(options?.enabled && options.orderingEnabled && listProviders().some(provider => provider.id === providerId && provider.capabilities.includes('provision')))
}

export async function saleProviders(db: DbOrTx, adminPreview = false) {
  const rows = await db.query.providers.findMany({ where: (t) => eq(t.mode, 'live') })
  return rows.filter(row => (adminPreview || row.enabled) && providerOrderingConfigured(row.id))
    .map(row => ({ ...row, name: providerConfig(row.id)?.displayName ?? row.name }))
}

/** Sales switch is independent of provider credentials and existing servers. */
export async function assertProviderPurchaseAllowed(db: DbOrTx, providerId: string, userId: string, retailOnly = false) {
  getProvider(providerId).require('provision')
  // A concurrent sales-disable waits for an already-accepted order transaction.
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).for('share')
  if (!provider) throw new ValidationError('دیتاسنتر یافت نشد')
  if (getConfig().NODE_ENV !== 'test' && (!providerOrderingConfigured(providerId) || provider.mode !== 'live')) {
    throw new AppError(403, 'provider_sales_unavailable', 'ثبت سفارش این دیتاسنتر فعلاً فعال نیست')
  }
  if (!provider.enabled) {
    if (retailOnly) throw new AppError(403, 'provider_sales_unavailable', 'ثبت سفارش این دیتاسنتر فعلاً فعال نیست')
    const user = await db.query.users.findFirst({ where: t => eq(t.id, userId) })
    if (!isActiveAdmin(user)) throw new ForbiddenError('خرید از این دیتاسنتر موقتاً غیرفعال است')
  }
}
