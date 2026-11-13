import pg, { type PoolClient } from 'pg'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getConfig } from '../../config.js'
import { AppError } from '../../lib/errors.js'
import { access } from 'node:fs/promises'
import path from 'node:path'

// Session-pinned locks use a SEPARATE bounded pool; holding all business-pool
// slots before handlers run would deadlock. API, jobs and migrations cooperate.
export const writerLock = [1953457774, 1937339252] as const
export const operationsLock = [1953457774, 1937339253] as const
export const maintenanceActive = () => access(path.join(getConfig().SYSTEM_BACKUP_DIR, 'maintenance.lock')).then(() => true, () => false)
export function coordinationPool(max = 24) {
  const pool = new pg.Pool({ connectionString: getConfig().DATABASE_URL, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, application_name: 'parserver-writer-gate' })
  pool.on('error', () => undefined)
  return pool
}
export async function sharedWriter(pool: pg.Pool) {
  const maintenance = await maintenanceActive()
  if (maintenance) throw new AppError(503, 'maintenance', 'بازیابی یا بررسی Recovery در جریان است؛ اپراتور باید پایان ایمن عملیات را تأیید کند.')
  const client = await pool.connect()
  try {
    const result = await client.query('select pg_try_advisory_lock_shared($1,$2) as acquired', [...writerLock])
    if (!result.rows[0]?.acquired) throw new AppError(503, 'maintenance', 'سامانه در حال بازیابی است؛ کمی بعد دوباره تلاش کنید.')
    return () => client.release(true)
  } catch (error) { client.release(true); throw error }
}
export async function exclusive(client: PoolClient, key: readonly number[]) {
  const result = await client.query('select pg_try_advisory_lock($1,$2) as acquired', [...key])
  if (!result.rows[0]?.acquired) throw new AppError(409, 'system_busy', 'عملیات دیگری، نویسندهٔ فعال یا Migration در حال اجراست؛ بعداً دوباره تلاش کنید.')
}
export function installWriterGate(app: FastifyInstance) {
  const pool = coordinationPool(), held = new WeakMap<FastifyRequest, () => void>()
  app.addHook('onRequest', async request => {
    // Monitoring remains reachable. All business routes, including GET payment
    // callbacks and auth session refreshes, must drain before a restore starts.
    if (/^\/api(?:\/v1)?\/health(?:\/|$)/.test(request.url.split('?')[0] ?? '')) return
    held.set(request, await sharedWriter(pool))
  })
  const release = (request: FastifyRequest) => { held.get(request)?.(); held.delete(request) }
  // Business handlers have completed at onSend. A slow file download must not
  // hold a PostgreSQL session/maintenance lock for its entire network transfer.
  app.addHook('onSend', async (request, _reply, payload) => { release(request); return payload })
  app.addHook('onResponse', async request => release(request))
  app.addHook('onError', async request => release(request))
  app.addHook('onClose', async () => pool.end())
}
