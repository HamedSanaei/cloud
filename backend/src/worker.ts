import { loadConfig, getConfig } from './config.js'
import { createLogger } from './logger.js'
import { createDb } from './db/index.js'
import { createCloudQueues, JOB_NAMES, type CloudQueues } from './jobs/queue.js'
import { createWorkers, type WorkerSet } from './jobs/workers.js'
import { registerConfiguredProviders } from './modules/providers/registry.js'
import { migrate } from './db/migrate.js'
import { retryStartup, startupFailure, waitForStartupDependencies } from './lib/startup.js'

async function main() {
  loadConfig()
  const config = getConfig()
  const logger = createLogger('cloud-worker')
  if (config.PLATFORM_API_URL) {
    logger.info('Unified mode: billing and provider jobs belong to the Python platform; legacy worker disabled')
    const { promise, resolve } = Promise.withResolvers<void>()
    const idle = setInterval(() => {}, 60_000)
    const stop = () => { clearInterval(idle); resolve() }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    await promise
    return
  }
  logger.info('starting cloud worker (env=%s, leaseweb_mode=%s)', config.NODE_ENV, config.LEASEWEB_MODE)
  await waitForStartupDependencies(logger)
  await migrate()
  const providers = registerConfiguredProviders()
  const dbHandle = createDb()
  let queues: CloudQueues | undefined
  let workerSet: WorkerSet | undefined
  const close = async () => {
    await workerSet?.close().catch(() => undefined)
    await queues?.close().catch(() => undefined)
    await dbHandle.pool.end().catch(() => undefined)
  }
  try {
    await retryStartup('worker-queues', async () => {
      queues = createCloudQueues()
      try {
        await queues.queue(JOB_NAMES.RENEWAL_SWEEP).waitUntilReady()
        await queues.scheduleRenewalSweep()
        await queues.queue(JOB_NAMES.SERVER_SYNC).upsertJobScheduler(
          'provisioning-status', { every: 30_000 }, { name: 'server-sync', data: {} },
        )
        if (config.CATALOG_SYNC_ENABLED) {
          for (const provider of providers) {
            await queues.queue(JOB_NAMES.CATALOG_SYNC).upsertJobScheduler(
              `catalog-${provider.id}`,
              { every: config.CATALOG_SYNC_INTERVAL_SECONDS * 1000 },
              { name: 'catalog-sync', data: { provider: provider.id } },
            )
          }
        }
        workerSet = createWorkers({ db: dbHandle.db, queues, logger })
        const readiness = await Promise.allSettled(workerSet.workers.map((worker) => worker.waitUntilReady()))
        for (const result of readiness) if (result.status === 'rejected') throw result.reason
      } catch (error) {
        await workerSet?.close().catch(() => undefined)
        await queues.close().catch(() => undefined)
        workerSet = undefined
        queues = undefined
        throw error
      }
    }, logger)
    await waitForStartupDependencies(logger)
    for (const worker of workerSet!.workers) {
      void worker.run().catch(async (error) => {
        logger.error({ event: 'worker_failed', ...startupFailure(error) }, 'worker stopped unexpectedly')
        await close()
        process.exit(1)
      })
    }
  } catch (error) {
    await close()
    throw error
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  logger.info('cloud worker ready')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'startup_failed', service: 'worker', ...startupFailure(error) }))
  process.exit(1)
})
