import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres'
import type { ExtractTablesWithRelations } from 'drizzle-orm/relations'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { getConfig } from '../config.js'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDb>

export type DbClient = NodePgDatabase<typeof schema>

/** A database instance OR a transaction — accepted by service helpers. */
export type DbOrTx =
  | DbClient
  | PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>

export function createDb(connectionString: string = getConfig().DATABASE_URL) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  // Swallow idle-client errors so the process does not crash; real failures
  // surface through query errors and health checks.
  pool.on('error', () => undefined)
  return {
    pool,
    db: drizzle(pool, { schema }) as DbClient,
    schema,
  }
}