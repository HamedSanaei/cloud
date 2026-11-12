import { eq } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { providers } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { getProvider } from '../providers/registry.js'

/** Sales switch is independent of provider credentials and existing servers. */
export async function assertProviderPurchaseAllowed(db: DbOrTx, providerId: string, userId: string) {
  getProvider(providerId).require('provision')
  const config = getConfig()
  const settings = providerId === 'hetzner' ? config.PROVIDERS.hetzner : config.PROVIDERS.leaseweb
  if (config.NODE_ENV !== 'test' && (!settings.enabled || !settings.orderingEnabled)) {
    throw new ValidationError('ثبت سفارش این دیتاسنتر فعلاً فعال نیست')
  }
  // A concurrent sales-disable waits for an already-accepted order transaction.
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).for('share')
  if (!provider) throw new ValidationError('دیتاسنتر یافت نشد')
  if (!provider.enabled) {
    const user = await db.query.users.findFirst({ where: t => eq(t.id, userId) })
    if (user?.role !== 'admin' || user.status !== 'active') throw new ForbiddenError('خرید از این دیتاسنتر موقتاً غیرفعال است')
  }
}
