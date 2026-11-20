import { sql, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'
import { normalizeSearchText } from '../contracts/search-text.js'

export const historyQuery = z.object({
  search: z.string().trim().max(200).default('').transform(normalizeSearchText),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export function containsSearch(text: SQLWrapper, term: string) {
  return sql`strpos(lower(translate(${text}, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789')), ${term}) > 0`
}

export function historyPage<T>(rows: T[], limit: number, offset: number) {
  return { data: rows.slice(0, limit), pagination: { offset, nextOffset: rows.length > limit ? offset + limit : null } }
}
