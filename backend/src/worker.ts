import { loadConfig, getConfig, redactSecrets } from './config.js'
import { createLogger } from './logger.js'
import { createDb } from './db/index.js'
import { createCloudQueues, JOB_NAMES } from './jobs/queue.js'
import { createWorkers } from './jobs/workers.js'
import { registerConfiguredProviders } from './modules/providers/registry.js'
import { migrate } from './db/migrate.js'

async function main() {
  loadConfig()
  const config = getConfig()
  const logger = createLogger('cloud-worker')
  if (config.PLATFORM_API_URL) {
    logger.info('Unified mode: billing and provider jobs belong to the Python platform; legacy worker disabled')
    await new Promise<void>(resolve => {
      const idle = setInterval(() => {}, 60_000)
      const stop = () => { clearInterval(idle); resolve() }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    })
    return
  }
  logger.info('starting cloud worker (env=%s, leaseweb_mode=%s)', config.NODE_ENV, config.LEASEWEB_MODE)

  await migrate()
  const providers = registerConfiguredProviders()

  const dbHandle = createDb()
  const queues = createCloudQueues()
  const workerSet = createWorkers({ db: dbHandle.db, queues, logger })

  // Schedule the periodic renewal sweep (idempotent).
  await queues.scheduleRenewalSweep()
  logger.info('renewal sweep scheduled')
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
    logger.info('provider catalog schedules installed')
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await workerSet.close().catch(() => undefined)
    await queues.close().catch(() => undefined)
    await dbHandle.pool.end().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  logger.info('cloud worker ready')
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] fatal:', redactSecrets((err as Error).stack ?? (err as Error).message))
  process.exit(1)
})
