import type { FastifyInstance } from 'fastify'
import { loadConfig, getConfig } from './config.js'
import { createLogger } from './logger.js'
import { createDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { createCloudQueues, JOB_NAMES, type CloudQueues } from './jobs/queue.js'
import { registerConfiguredProviders } from './modules/providers/registry.js'
import { buildApp } from './app.js'
import { assertUnifiedCutoverReady } from './modules/integration/platform.js'
import { assertAuthenticationReady } from './modules/auth/readiness.js'
import { retryStartup, startupFailure, waitForStartupDependencies } from './lib/startup.js'

async function main() {
  loadConfig()
  const config = getConfig()
  const logger = createLogger('cloud-api')
  if (config.NODE_ENV === 'production' && config.PLATFORM_API_URL) assertAuthenticationReady()
  await waitForStartupDependencies(logger)
  await migrate()
  if (!config.PLATFORM_API_URL) registerConfiguredProviders()

  const dbHandle = createDb()
  let queues: CloudQueues | undefined
  let app: FastifyInstance | undefined
  const closeHandles = async () => {
    await queues?.close().catch(() => undefined)
    await dbHandle.pool.end().catch(() => undefined)
  }
  try {
    await retryStartup('cutover', () => assertUnifiedCutoverReady(dbHandle.db), logger)
    await retryStartup('api-queues', async () => {
      queues = createCloudQueues()
      try {
        await queues.queue(JOB_NAMES.RENEWAL_SWEEP).waitUntilReady()
      } catch (error) {
        await queues.close().catch(() => undefined)
        queues = undefined
        throw error
      }
    }, logger)
    app = await buildApp({ db: dbHandle.db, queues: queues!, logger, exposeDocs: config.NODE_ENV !== 'production' })
    app.addHook('onClose', closeHandles)
    await app.ready()
    // Repeat dependency checks after app registration: never listen on stale readiness.
    await waitForStartupDependencies(logger)
    await app.listen({ host: config.HOST, port: config.PORT })
  } catch (error) {
    if (app) await app.close().catch(() => undefined)
    else await closeHandles()
    throw error
  }

  const runningApp = app
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down api')
    await runningApp.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  logger.info('cloud api listening on %s:%d', config.HOST, config.PORT)
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'startup_failed', service: 'api', ...startupFailure(error) }))
  process.exit(1)
})
