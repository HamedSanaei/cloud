import { and, eq } from 'drizzle-orm'
import { idempotencyKeys } from '../db/schema.js'
import type { DbClient } from '../db/index.js'
import { ConflictError } from './errors.js'

export interface IdempotencyRecord {
  status: number
  body: unknown
}

/**
 * Generic idempotency guard. Callers pass a scope (e.g. `user:<id>`) and the
 * key from the Idempotency-Key header. On first call the provided fn runs and
 * its result is stored; subsequent calls with the same (scope, key) return the
 * stored result instead of executing fn again.
 *
 * Storage happens AFTER fn succeeds — a browser double-click during the first
 * request can still hit the wallet/order DB-level uniqueness guards, which are
 * the ultimate protection.
 */
export async function withIdempotency(
  db: DbClient,
  scope: string,
  key: string | undefined,
  fn: () => Promise<{ status: number; body: unknown }>,
  ttlMs = 24 * 60 * 60 * 1000,
): Promise<IdempotencyRecord> {
  if (!key) return fn()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new ConflictError('Idempotency-Key نامعتبر است')
  }

  const existing = await db.query.idempotencyKeys.findFirst({
    where: and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)),
  })
  if (existing) {
    return { status: existing.responseStatus, body: existing.responseBody }
  }

  const result = await fn()
  await db
    .insert(idempotencyKeys)
    .values({
      scope,
      key,
      responseStatus: result.status,
      responseBody: result.body,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .onConflictDoNothing()
  return result
}