import { lt, sql } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { systemEvents } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { access } from 'node:fs/promises'
import path from 'node:path'

let sink: DbClient | undefined, inFlight = 0, nextCleanup = 0
export function installEventSink(db: DbClient) { sink = db }
const safeKeys = new Set(['userId', 'walletId', 'adjustmentId', 'backupId', 'requestId', 'requestedBy', 'approvedBy', 'originalActorId', 'amountRial', 'beforeRial', 'afterRial', 'direction', 'status', 'result', 'code', 'queue', 'jobId', 'operation', 'enabled', 'sandbox', 'method', 'route', 'httpStatus', 'elapsedMs'])
export function safeMetadata(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => safeKeys.has(k) && (k !== 'code' || typeof v === 'string' && /^[a-z][a-z0-9_]{0,80}$/i.test(v)) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' && !/^eyJ|^Bearer/i.test(v) && /^[a-zA-Z0-9_:/ .-]{1,100}$/.test(v))))
}
// A bounded sanitized event mirror, not a copy of raw Pino messages/headers.
// Audit writes remain transactional/awaited and are never dropped here.
export function recordEvent(event: string, level: string, service: string, metadata?: unknown, requestId?: string) {
  if (!sink || inFlight >= 100) return
  const db = sink; inFlight++
  const persist = async () => {
    if (await access(path.join(getConfig().SYSTEM_BACKUP_DIR, 'maintenance.lock')).then(() => true, () => false)) return
    await db.insert(systemEvents).values({ event: event.slice(0, 100), level, service: service.slice(0, 40), metadata: safeMetadata(metadata),
    requestId: requestId && /^[a-zA-Z0-9_.-]{1,100}$/.test(requestId) ? requestId : null })
      if (Date.now() < nextCleanup) return
      nextCleanup = Date.now() + 3600000
      await db.delete(systemEvents).where(sql`${systemEvents.id} in (select id from system_events where ${lt(systemEvents.createdAt, new Date(Date.now() - getConfig().SYSTEM_LOG_RETENTION_DAYS * 86400000))} order by created_at limit 5000)`)
  }
  void persist().catch(() => undefined).finally(() => { inFlight-- })
}
