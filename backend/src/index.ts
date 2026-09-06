import { loadConfig, getConfig, redactSecrets } from './config.js'
import { createLogger } from './logger.js'
import { createDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { createCloudQueues } from './jobs/queue.js'
import { registerConfiguredProviders } from './modules/providers/registry.js'
import { buildApp } from './app.js'
import { syncProviderCatalog } from './modules/catalog/service.js'
import { getProvider } from './modules/providers/registry.js'

async function main() {
  loadConfig()
  const config = getConfig()
  const logger = createLogger('cloud-api')

  await migrate()
  registerConfiguredProviders()

  const dbHandle = createDb()
  const queues = createCloudQueues()

  // Seed the catalog on first boot so the API is immediately usable in mock
  // mode (idempotent; safe with live mode too since it reads the provider API).
  try {
    await syncProviderCatalog(dbHandle.db, getProvider(config.DEFAULT_PROVIDER))
    logger.info('provider catalog synchronized on startup')
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'catalog sync at startup failed (will retry via job)')
    await queues.addCatalogSync(config.DEFAULT_PROVIDER, null)
  }

  const app = await buildApp({ db: dbHandle.db, queues, logger, exposeDocs: !['production'].includes(config.NODE_ENV) })
  app.addHook('onClose', async () => {
    await queues.close().catch(() => undefined)
    await dbHandle.pool.end().catch(() => undefined)
  })

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down api')
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: config.HOST, port: config.PORT })
  logger.info('cloud api listening on %s:%d (leaseweb_mode=%s, ordering_enabled=%s)', config.HOST, config.PORT, config.LEASEWEB_MODE, config.LEASEWEB_ORDERING_ENABLED)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[api] fatal:', redactSecrets((err as Error).stack ?? (err as Error).message))
  process.exit(1)
})