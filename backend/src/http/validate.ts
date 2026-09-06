import type { ZodType } from 'zod'
import { ValidationError } from '../lib/errors.js'

export function parse<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = issues[0]
    throw new ValidationError(first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'داده ورودی نامعتبر است', issues)
  }
  return result.data
}

export function parseIntParam(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}