import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator'
import { createDb } from './index.js'
import { getConfig, loadConfig } from '../config.js'

/**
 * Applies committed SQL migrations (backend/drizzle/*.sql).
 * Migrations are explicit and versioned — schema is never auto-created.
 * Called once by the API/worker entrypoints before serving.
 */
export async function migrate(connectionString?: string): Promise<void> {
  // Load env into the config cache (a CLI run may not have called loadConfig).
  loadConfig()
  const handle = createDb(connectionString ?? getConfig().DATABASE_URL)
  try {
    await drizzleMigrate(handle.db, { migrationsFolder: resolveMigrationsFolder() })
  } finally {
    await handle.pool.end()
  }
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
      console.error('[migrate] failed:', (err as Error).message)
      process.exit(1)
    })
}