import { z } from 'zod'

export const walletHistoryQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
}).refine(query => !query.since || !query.until || Date.parse(query.since) < Date.parse(query.until), 'بازهٔ تراکنش‌ها معتبر نیست')

export function walletHistoryPage<T>(rows: T[], limit: number, offset: number) {
  return { data: rows.slice(0, limit), pagination: { nextOffset: rows.length > limit ? offset + limit : null } }
}
