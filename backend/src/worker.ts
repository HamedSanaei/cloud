import { loadConfig, getConfig, redactSecrets } from './config.js'
import { createLogger } from './logger.js'
import { createDb } from './db/index.js'
import { createCloudQueues } from './jobs/queue.js'
import { createWorkers } from './jobs/workers.js'
import { registerConfiguredProviders } from './modules/providers/registry.js'
import { migrate } from './db/migrate.js'

async function main() {
  loadConfig()
  const config = getConfig()
  const logger = createLogger('cloud-worker')
  logger.info('starting cloud worker (env=%s, leaseweb_mode=%s)', config.NODE_ENV, config.LEASEWEB_MODE)

  await migrate()
  registerConfiguredProviders()

  const dbHandle = createDb()
  const queues = createCloudQueues()
  const workerSet = createWorkers({ db: dbHandle.db, queues, logger })

  // Schedule the periodic renewal sweep (idempotent).
  await queues.scheduleRenewalSweep()
  logger.info('renewal sweep scheduled')

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