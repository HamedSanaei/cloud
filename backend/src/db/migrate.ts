import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg, { type PoolClient } from 'pg'
import { getConfig, loadConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { retryStartup, startupFailure } from '../lib/startup.js'

// Stable, database-scoped key shared by CLI, API and worker.
const migrationLock = [1953457774, 1835624306] as const

/**
 * Applies committed SQL migrations (backend/drizzle/*.sql).
 * Migrations are explicit and versioned — schema is never auto-created.
 * Called once by the API/worker entrypoints before serving.
 */
export async function migrate(connectionString?: string): Promise<void> {
  // Load env into the config cache (a CLI run may not have called loadConfig).
  loadConfig()
  const logger = createLogger('cloud-migrate')
  const migrationsFolder = resolveMigrationsFolder()
  await retryStartup('migrations', async () => {
    const pool = new pg.Pool({
      connectionString: connectionString ?? getConfig().DATABASE_URL,
      max: 1, connectionTimeoutMillis: 10_000, query_timeout: 125_000,
    })
    pool.on('error', () => undefined)
    let client: PoolClient | undefined
    try {
      client = await pool.connect()
      client.on('error', (error) => {
        logger.warn({ event: 'migration_connection_error', ...startupFailure(error) }, 'migration session connection failed')
      })
      // A checked-out client pins the advisory lock, journal reads and Drizzle's
      // migration transaction to ONE PostgreSQL session (never the pool).
      await client.query('select 1')
      await client.query("set statement_timeout = '120s'")
      await client.query("set lock_timeout = '10s'")
      const lock = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1::integer, $2::integer) as acquired', [...migrationLock],
      )
      if (!lock.rows[0]?.acquired) throw Object.assign(new Error('Migration lock is held'), { code: 'migration_lock_busy' })
      await drizzleMigrate(drizzle(client), { migrationsFolder })
    } finally {
      // Destroy this session even on success: releasing a session lock this way
      // cannot leak a held lock to a pool borrower, even after a failed rollback.
      client?.release(true)
      await pool.end()
    }
  }, logger)
}

/**
 * Locates backend/drizzle regardless of how the code runs:
 *  - dev (tsx):   src/db/migrate.ts  -> ../../drizzle
 *  - built (node): dist/db/migrate.js -> ../drizzle
 *  - container:   cwd is /app        -> /app/drizzle
 */
export function resolveMigrationsFolder(): string {
  const here = fileURLToPath(import.meta.url)
  const candidates = [
    path.resolve(path.dirname(here), '../../drizzle'),
    path.resolve(path.dirname(here), '../drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
  ]
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error(`drizzle migrations folder not found (tried: ${candidates.join(', ')})`)
  return found
}

// CLI entrypoint: `npm run db:migrate` (or `node dist/db/migrate.js`) applies
// migrations and exits. Importing this module (API/worker) does not run it.
const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ event: 'startup_failed', service: 'migrate', ...startupFailure(err) }))
      process.exit(1)
    })
}