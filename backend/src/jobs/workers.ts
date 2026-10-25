import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { DbClient } from '../db/index.js'
import { getConfig } from '../config.js'
import type { Logger } from '../logger.js'
import { startupFailure } from '../lib/startup.js'
import type { CloudQueues, JobName } from './queue.js'
import { JOB_NAMES } from './queue.js'
import {
  handleCatalogSync,
  handleProvision,
  handleReconcile,
  handleRenewalSweep,
  handleServerAction,
  handleServerSync,
  type HandlerContext,
} from '../modules/provisioning/handlers.js'

export interface WorkerSet {
  workers: Worker[]
  close(): Promise<void>
}

export function createWorkers(opts: { db: DbClient; queues: CloudQueues; logger: Logger; redisUrl?: string }): WorkerSet {
  const redisUrl = opts.redisUrl ?? getConfig().REDIS_URL
  let ready = false
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, enableReadyCheck: false, connectTimeout: 3_000,
    retryStrategy: (attempt) => ready ? Math.min(attempt * 50, 2_000) : null,
  })
  connection.on('error', (error) => {
    opts.logger.warn({ event: 'worker_connection_error', ...startupFailure(error) }, 'worker connection failed')
  })
  const ctx: HandlerContext = { db: opts.db, queues: opts.queues }
  const workers: Worker[] = []

  function makeWorker(queueName: JobName, handler: (data: unknown) => Promise<unknown>) {
    const w = new Worker(
      queueName,
      async (job) => {
        const started = Date.now()
        try {
          const result = await handler(job.data)
          opts.logger.info({ queue: queueName, jobId: job.id, ms: Date.now() - started }, 'job completed')
          return result
        } catch (err) {
          opts.logger.warn({ queue: queueName, jobId: job.id, error: (err as Error).message }, 'job failed')
          throw err
        }
      },
      { connection, prefix: 'cloud', concurrency: 4, autorun: false },
    )
    w.on('failed', (job, err) => {
      opts.logger.error({ queue: queueName, jobId: job?.id, error: err.message }, 'job permanently failed')
    })
    w.on('error', (error) => {
      opts.logger.error({ event: 'worker_connection_error', queue: queueName, ...startupFailure(error) }, 'worker connection failed')
    })
    workers.push(w)
    return w
  }

  makeWorker(JOB_NAMES.CATALOG_SYNC, (data) => handleCatalogSync(ctx, data as { provider: string; actorId?: string | null }))
  makeWorker(JOB_NAMES.PROVISION, (data) => handleProvision(ctx, data as { orderId: string }))
  makeWorker(JOB_NAMES.RECONCILE, (data) => handleReconcile(ctx, data as { operationId?: string }))
  makeWorker(JOB_NAMES.SERVER_SYNC, (data) => handleServerSync(ctx, data as { serverId?: string }))
  makeWorker(JOB_NAMES.SERVER_ACTION, (data) =>
    handleServerAction(ctx, data as { operationId: string; serverId: string; action: 'power_on' | 'power_off' | 'reboot' }),
  )
  makeWorker(JOB_NAMES.RENEWAL_SWEEP, () => handleRenewalSweep(ctx))
  // Initial failures reject readiness instead of reconnecting forever. Runtime
  // reconnects remain enabled once all six worker connections are established.
  void Promise.allSettled(workers.map((worker) => worker.waitUntilReady())).then((results) => {
    ready = results.every((result) => result.status === 'fulfilled')
  })

  return {
    workers,
    async close() {
      if (!ready) connection.disconnect()
      await Promise.all(workers.map((w) => w.close(!ready)))
      connection.disconnect()
    },
  }
}