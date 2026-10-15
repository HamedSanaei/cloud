import { getConfig } from '../../config.js'
import { createLogger } from '../../logger.js'
import type { CloudProvider } from './provider.interface.js'
import { createMockLeasewebProvider } from './leaseweb/mock.js'
import { createLiveLeasewebProvider } from './leaseweb/live.js'
import { NotFoundError } from '../../lib/errors.js'
import { createHetznerProvider } from './hetzner/live.js'


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

/** Register only configured providers; production never falls back to mock data. */
export function registerConfiguredProviders(): CloudProvider[] {
  const config = getConfig()
  registry.clear()
  if (config.PROVIDERS.hetzner.enabled) registerProvider(createHetznerProvider(config.PROVIDERS.hetzner))
  if (config.PROVIDERS.leaseweb.enabled) {
    registerProvider(createLiveLeasewebProvider({ ...config.PROVIDERS.leaseweb, logger: createLogger('leaseweb') }))
  }
  if (registry.size === 0 && config.NODE_ENV !== 'production' && config.LEASEWEB_MODE === 'mock') {
    registerProvider(createMockLeasewebProvider())
  }
  return listProviders()
}

export function getDefaultProvider(): CloudProvider {
  return getProvider(getConfig().DEFAULT_PROVIDER)
}