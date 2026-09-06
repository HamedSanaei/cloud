import { getConfig } from '../../config.js'
import { createLogger } from '../../logger.js'
import type { CloudProvider } from './provider.interface.js'
import { createMockLeasewebProvider } from './leaseweb/mock.js'
import { createLiveLeasewebProvider } from './leaseweb/live.js'
import { NotFoundError } from '../../lib/errors.js'

const providerLogger = createLogger('leaseweb')

const registry = new Map<string, CloudProvider>()

export function registerProvider(provider: CloudProvider): void {
  registry.set(provider.id, provider)
}

export function getProvider(id: string): CloudProvider {
  const p = registry.get(id)
  if (!p) throw new NotFoundError(`Provider '${id}' is not registered`)
  return p
}

export function listProviders(): CloudProvider[] {
  return [...registry.values()]
}

/**
 * Build and register providers from configuration. Mock is the default and is
 * ALWAYS available (safe); live is only registered when configured.
 */
export function registerConfiguredProviders(): CloudProvider[] {
  const config = getConfig()
  const providers: CloudProvider[] = []

  const mock = createMockLeasewebProvider()
  registerProvider(mock)
  providers.push(mock)

  if (config.LEASEWEB_MODE === 'live') {
    const live = createLiveLeasewebProvider({
      baseUrl: config.LEASEWEB_API_BASE_URL,
      apiKey: config.LEASEWEB_API_KEY,
      orderingEnabled: config.LEASEWEB_ORDERING_ENABLED,
      logger: providerLogger,
    })
    registerProvider(live)
    providers.push(live)
  }

  return providers
}

export function getDefaultProvider(): CloudProvider {
  return getProvider(getConfig().DEFAULT_PROVIDER)
}