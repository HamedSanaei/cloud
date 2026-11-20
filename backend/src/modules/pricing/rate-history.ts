import type { DbOrTx } from '../../db/index.js'
import { fxRates } from '../../db/schema.js'
import { ValidationError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'

export async function saveFxRate(db: DbOrTx, rate: string, opts: { actorId?: string | null; note?: string; currency?: string; source?: 'market' } = {}) {
  const numeric = Number(rate)
  if (!Number.isFinite(numeric) || numeric <= 0) throw new ValidationError('نرخ ارز باید عددی مثبت باشد')
  const currency = opts.currency === 'USD' ? 'USDT' : opts.currency ?? 'EUR'
  const [row] = await db.insert(fxRates)
    .values({ fromCurrency: currency, toCurrency: 'IRR', rate, setBy: opts.actorId ?? null, note: opts.note ?? null, createdAt: new Date() })
    .returning()
  if (!row) throw new Error('failed to set fx rate')
  await writeAudit(db, { actorId: opts.actorId ?? null, action: opts.source === 'market' ? 'pricing.fx_rate.refreshed' : 'admin.fx_rate.changed',
    metadata: { rate, from: currency, to: 'IRR', ...(opts.source === 'market' ? { source: opts.note } : {}) } })
  return row
}
