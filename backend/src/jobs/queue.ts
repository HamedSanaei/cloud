import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { getConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { startupFailure } from '../lib/startup.js'

export const JOB_NAMES = {
  CATALOG_SYNC: 'catalog.sync',
  PROVISION: 'provision',
  RECONCILE: 'reconcile',
  SERVER_SYNC: 'server.sync',
  SERVER_ACTION: 'server.action',
  RENEWAL_SWEEP: 'renewal.sweep',
} as const

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES]

export interface ProvisionJobData {
  orderId: string
}

export interface CatalogSyncJobData {
  provider: string
  actorId?: string | null
}

export interface ServerActionJobData {
  operationId: string
  serverId: string
  action: 'power_on' | 'power_off' | 'reboot'
}

export interface ServerSyncJobData {
  serverId: string
}

export interface ReconcileJobData {
  operationId?: string
}

export interface CloudQueues {
  queue(name: JobName): Queue
  addProvision(orderId: string): Promise<void>
  addCatalogSync(provider: string, actorId?: string | null): Promise<void>
  addServerAction(data: ServerActionJobData): Promise<void>
  addServerSync(serverId: string, delayMs?: number): Promise<void>
  addReconcile(operationId?: string): Promise<void>
  scheduleRenewalSweep(): Promise<void>
  close(): Promise<void>
}

export function createCloudQueues(redisUrl: string = getConfig().REDIS_URL): CloudQueues {
  const logger = createLogger('cloud-queues')
  let ready = false
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => ready ? Math.min(attempt * 50, 2_000) : null,
  })
  connection.on('error', (error) => {
    logger.warn({ event: 'queue_connection_error', ...startupFailure(error) }, 'queue connection failed')
  })
  connection.once('ready', () => { ready = true })
  const queues = new Map<JobName, Queue>()

  function queue(name: JobName): Queue {
    let q = queues.get(name)
    if (!q) {
      q = new Queue(name, { connection, prefix: 'cloud' })
      q.on('error', (error) => {
        logger.warn({ event: 'queue_error', queue: name, ...startupFailure(error) }, 'queue operation failed')
      })
      queues.set(name, q)
    }
    return q
  }

  return {
    queue,

    async addProvision(orderId: string) {
      await queue(JOB_NAMES.PROVISION).add(
        'provision',
        { orderId } satisfies ProvisionJobData,
        {
          attempts: 6,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      )
    },

    async addCatalogSync(provider: string, actorId?: string | null) {
      await queue(JOB_NAMES.CATALOG_SYNC).add('catalog-sync', { provider, actorId } satisfies CatalogSyncJobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      })
    },

    async addServerAction(data: ServerActionJobData) {
      await queue(JOB_NAMES.SERVER_ACTION).add('server-action', data, {
        attempts: 4,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      })
    },

    async addServerSync(serverId: string, delayMs = 0) {
      await queue(JOB_NAMES.SERVER_SYNC).add('server-sync', { serverId } satisfies ServerSyncJobData, {
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      })
    },

    async addReconcile(operationId?: string) {
      await queue(JOB_NAMES.RECONCILE).add('reconcile', { operationId } satisfies ReconcileJobData, {
        attempts: 4,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      })
    },

    async scheduleRenewalSweep() {
      // Minute-level sweeps serve hourly and daily subscriptions without early charging.
      await queue(JOB_NAMES.RENEWAL_SWEEP).upsertJobScheduler(
        'renewal-sweep',
        { every: 60 * 1000 },
        { name: 'renewal-sweep', data: {} },
      )
    },

    async close() {
      // Stop reconnecting before waiting for queue initialization/commands.
      connection.disconnect()
      for (const q of queues.values()) await q.close()
    },
  }
}