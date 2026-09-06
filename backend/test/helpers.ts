import { afterAll, beforeAll, describe, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { pino } from 'pino'
import { createDb, type DbClient } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'

export const testLogger = pino({ level: 'silent' })
import { registerConfiguredProviders, getProvider } from '../src/modules/providers/registry.js'
import type { CloudQueues } from '../src/jobs/queue.js'
import { createMockLeasewebProvider, type MockLeasewebProvider } from '../src/modules/providers/leaseweb/mock.js'

export const DATABASE_URL = process.env.DATABASE_URL ?? ''
export const REDIS_URL = process.env.REDIS_URL ?? ''

export const dbAvailable = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://')
export const redisAvailable = REDIS_URL.startsWith('redis://')

/** Fake queue — records enqueues, never touches Redis. */
export function createFakeQueues(): CloudQueues {
  const calls: Array<{ name: string; data: unknown }> = []
  return {
    queue: () => {
      throw new Error('fake queues have no real queue')
    },
    async addProvision(orderId) {
      calls.push({ name: 'provision', data: { orderId } })
    },
    async addCatalogSync(provider, actorId) {
      calls.push({ name: 'catalog-sync', data: { provider, actorId } })
    },
    async addServerAction(data) {
      calls.push({ name: 'server-action', data })
    },
    async addServerSync(serverId) {
      calls.push({ name: 'server-sync', data: { serverId } })
    },
    async addReconcile(operationId) {
      calls.push({ name: 'reconcile', data: { operationId } })
    },
    async scheduleRenewalSweep() {
      calls.push({ name: 'renewal-sweep', data: {} })
    },
    async close() {
      /* noop */
    },
    calls,
  } as CloudQueues & { calls: Array<{ name: string; data: unknown }> }
}

export type TestContext = {
  db: DbClient
  queues: ReturnType<typeof createFakeQueues>
  mockProvider: MockLeasewebProvider
  close: () => Promise<void>
}

let ctx: TestContext | null = null

export async function getTestContext(): Promise<TestContext> {
  if (ctx) return ctx
  if (!dbAvailable) throw new Error('DATABASE_URL not configured — integration tests skipped')
  await migrate(DATABASE_URL)
  const handle = createDb(DATABASE_URL)
  registerConfiguredProviders()
  const mockProvider = createMockLeasewebProvider()
  // The registry may already have a mock; replace it with our controllable one.
  const { registerProvider } = await import('../src/modules/providers/registry.js')
  registerProvider(mockProvider)
  ctx = {
    db: handle.db,
    queues: createFakeQueues(),
    mockProvider,
    close: async () => {
      await handle.pool.end()
      ctx = null
    },
  }
  return ctx
}

/** Wipe all business tables between tests (schema stays). */
export async function truncateAll(db: DbClient): Promise<void> {
  const tables = [
    'renewal_attempts',
    'subscription_events',
    'subscriptions',
    'servers',
    'provider_operations',
    'order_events',
    'order_items',
    'invoices',
    'invoice_items',
    'orders',
    'quotes',
    'wallet_transactions',
    'wallets',
    'sessions',
    'notifications',
    'tickets',
    'charge_requests',
    'audit_logs',
    'idempotency_keys',
    'fx_rates',
    'pricing_rules',
    'provider_products',
    'provider_locations',
    'product_sync_runs',
    'users',
  ]
  await db.execute(sql`truncate table ${sql.raw(tables.join(', '))} cascade`)
}

export { describe, it, beforeAll, afterAll }

export function getMock(): MockLeasewebProvider {
  const p = getProvider('leaseweb') as unknown as MockLeasewebProvider
  if (!p || typeof p.setBehavior !== 'function') {
    // Fall back to a standalone controllable mock (registry holds the plain one
    // in CI, so tests that need behavior control use the exported instance).
    return createMockLeasewebProvider()
  }
  return p
}