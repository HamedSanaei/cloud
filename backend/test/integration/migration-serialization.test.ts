import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/db/migrate.js'
import * as logging from '../../src/logger.js'
import { DATABASE_URL, dbAvailable, testLogger } from '../helpers.js'

describe.skipIf(!dbAvailable)('PostgreSQL migration serialization (integration)', () => {
  it('makes both concurrent callers wait for the shared advisory lock without duplicating the journal', async () => {
    await migrate(DATABASE_URL)
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })
    const owner = await pool.connect()
    const before = await owner.query('select count(*)::integer as count from drizzle.__drizzle_migrations')
    await owner.query('select pg_advisory_lock($1::integer, $2::integer)', [1953457774, 1835624306])
    const contended = Promise.withResolvers<void>()
    let waits = 0
    const loggerSpy = vi.spyOn(logging, 'createLogger').mockReturnValue(testLogger)
    const warnSpy = vi.spyOn(testLogger, 'warn').mockImplementation((fields) => {
      if (fields && typeof fields === 'object' && 'code' in fields && fields.code === 'migration_lock_busy' && ++waits === 2) contended.resolve()
    })
    let finished = 0
    const first = migrate(DATABASE_URL).then(() => { finished++ })
    const second = migrate(DATABASE_URL).then(() => { finished++ })
    try {
      // Await actual lock-contention events, never a guessed wall-clock sleep.
      await Promise.race([
        contended.promise,
        Promise.all([first, second]).then(() => { throw new Error('Migrations bypassed the held advisory lock') }),
      ])
      expect(finished).toBe(0)
      await owner.query('select pg_advisory_unlock($1::integer, $2::integer)', [1953457774, 1835624306])
      await Promise.all([first, second])
      expect(finished).toBe(2)
      const after = await owner.query('select count(*)::integer as count from drizzle.__drizzle_migrations')
      expect(after.rows[0].count).toBe(before.rows[0].count)
      const lock = await owner.query<{ acquired: boolean }>('select pg_try_advisory_lock($1::integer, $2::integer) as acquired', [1953457774, 1835624306])
      expect(lock.rows[0]?.acquired).toBe(true)
    } finally {
      // Session destruction releases even the assertion-path lock.
      owner.release(true)
      await Promise.allSettled([first, second])
      await pool.end()
      warnSpy.mockRestore()
      loggerSpy.mockRestore()
    }
  })
})
