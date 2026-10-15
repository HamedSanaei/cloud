import { createHash } from 'node:crypto'
import type { HetznerConfig, ProviderAccount } from '../../../config.js'
import { ProviderPermanentError, ProviderUnknownError } from '../../../lib/errors.js'
import {
  NotSupportedError, type CloudProvider, type ProviderCapability, type ProviderOrderRequest,
  type ProviderServerView, type RecoveryResult,
} from '../provider.interface.js'
import { decimal, readCatalog, type HetznerCatalog } from './catalog.js'
import { HetznerApiError, HetznerClient, object, type ApiObject } from './client.js'

export interface HetznerProviderOptions { fetch?: typeof fetch }

/** The exact operation reference, not a hostname, is the sole inventory proof. */
export function operationLabel(clientReference: string): string {
  return createHash('sha256').update(clientReference).digest('base64url')
}

export function createHetznerProvider(config: HetznerConfig, options: HetznerProviderOptions = {}): CloudProvider {
  const accounts = config.accounts.map((account) => ({ ...account })).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  const clients = new Map<string, HetznerClient>()
  const ids = new Set<string>()
  for (const account of accounts) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(account.id) || ids.has(account.id)) throw new ProviderPermanentError('Hetzner account ids must be unique and valid')
    ids.add(account.id)
    if (account.enabled && account.state !== 'disabled' && !account.apiToken?.trim()) throw new ProviderPermanentError('Hetzner active account requires a credential')
    if (account.apiToken && /\s/.test(account.apiToken)) throw new ProviderPermanentError('Hetzner account credential is invalid')
    // Disabled accounts remain addressable for already-owned resources.
    if (account.apiToken) clients.set(account.id, new HetznerClient(config.baseUrl, account.apiToken, options.fetch ?? fetch))
  }
  const secrets = accounts.flatMap((account) => [account.apiToken ?? '', account.apiKey ?? '']).filter(Boolean).sort((a, b) => b.length - a.length)
  function clean(value: string): string {
    let result = value
    for (const secret of secrets) result = result.split(secret).join('***REDACTED***')
    return result
  }
  const active = accounts.filter((account) => account.enabled && account.state === 'active')
  function clientFor(account: ProviderAccount): HetznerClient {
    const client = clients.get(account.id)
    if (!client) throw new ProviderPermanentError('Hetzner owning account has no usable credential')
    return client
  }
  function owner(providerServerId: string): { account: ProviderAccount; id: string; composite: string } {
    const parts = providerServerId.split(':')
    const accountId = parts.length === 2 ? parts[0] : (accounts.find((account) => account.id === 'default')?.id ?? (accounts.length === 1 ? accounts[0]?.id : undefined))
    const id = parts.length === 2 ? parts[1] : parts.length === 1 ? parts[0] : undefined
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account || !id || !/^[1-9]\d*$/.test(id)) throw new ProviderPermanentError('Hetzner server ownership is unknown; refusing credential substitution')
    return { account, id, composite: `${account.id}:${id}` }
  }
  function mapServer(account: ProviderAccount, server: ApiObject): ProviderServerView {
    if (typeof server.id !== 'number' || !Number.isSafeInteger(server.id) || server.id <= 0) throw new ProviderUnknownError('Hetzner response did not prove a server id')
    const type = object(server.server_type)
    const network = object(server.public_net)
    const ipv4 = object(network.ipv4).ip
    const ipv6 = object(network.ipv6).ip
    const state: ProviderServerView['state'] = server.status === 'running' ? 'active'
      : server.status === 'off' ? 'suspended'
        : ['initializing', 'starting', 'stopping', 'rebuilding', 'migrating'].includes(String(server.status)) ? 'provisioning' : 'unknown'
    return {
      providerServerId: `${account.id}:${server.id}`, state,
      ...(typeof server.name === 'string' ? { hostname: clean(server.name) } : {}),
      ...(typeof ipv4 === 'string' ? { ipv4: clean(ipv4) } : {}),
      ...(typeof ipv6 === 'string' ? { ipv6: clean(ipv6) } : {}),
      ...(typeof type.cores === 'number' ? { vcpu: type.cores } : {}),
      ...(typeof type.memory === 'number' ? { memoryMb: Math.round(type.memory * 1024) } : {}),
      ...(typeof type.disk === 'number' ? { diskGb: type.disk } : {}),
      ...(typeof server.outgoing_traffic === 'number' ? { trafficUsedGb: server.outgoing_traffic / 1_000_000_000 } : {}),
      metadata: { ...(typeof server.created === 'string' ? { createdAt: clean(server.created) } : {}) },
    }
  }
  async function action(providerServerId: string, name: string) {
    const route = owner(providerServerId)
    const data = await clientFor(route.account).request('POST', `/servers/${route.id}/actions/${name}`)
    const result = object(data.action)
    if (typeof result.id !== 'number' || result.status === 'error') throw new ProviderUnknownError('Hetzner action has no proven accepted outcome')
    return { ok: true, metadata: { actionId: result.id } }
  }
  const capabilities: ProviderCapability[] = ['catalog', 'provision', 'power_on', 'power_off', 'reboot', 'reconcile', 'traffic']
  return {
    id: 'hetzner', name: clean(config.displayName), capabilities,
    supports(capability) { return capabilities.includes(capability) },
    require(capability) { if (!capabilities.includes(capability)) throw new NotSupportedError(capability) },
    async syncCatalog() {
      if (!config.enabled) throw new ProviderPermanentError('Hetzner provider is disabled')
      if (!active.length) throw new ProviderPermanentError('Hetzner has no active provisioning account')
      const offers = new Map<string, HetznerCatalog['offers'][number]>()
      const locations = new Map<string, HetznerCatalog['locations'][number]>()
      for (const account of active) {
        const catalog = await readCatalog(clientFor(account), clean)
        for (const location of catalog.locations) locations.set(location.code, location)
        // Account routing is private. One published offer is backed by the first
        // eligible account; create revalidates exact price/image on every route.
        for (const offer of catalog.offers) {
          const key = `${offer.providerProductId}:${offer.location}`
          if (!offers.has(key)) offers.set(key, offer)
        }
      }
      return { offers: [...offers.values()], locations: [...locations.values()], raw: { source: 'hetzner-api' } }
    },
    async createServer(req: ProviderOrderRequest) {
      if (!config.enabled || !config.orderingEnabled) throw new ProviderPermanentError('Hetzner ordering is disabled')
      if (!req.clientReference) throw new ProviderPermanentError('Hetzner provisioning requires an operation client reference')
      if (req.quantity !== undefined && req.quantity !== 1) throw new ProviderPermanentError('Hetzner provisioning accepts one server per operation')
      const label = operationLabel(req.clientReference)
      const hostname = req.hostname ?? `server-${label.slice(0, 12)}`
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(hostname)) throw new ProviderPermanentError('Hetzner hostname is invalid')
      if (req.billingOption.billingCycle !== 'hourly' || req.billingOption.amount === undefined) throw new ProviderPermanentError('Hetzner requires its exact hourly billing option')
      let capacity: HetznerApiError | undefined
      for (const account of active) {
        const client = clientFor(account)
        const catalog = await readCatalog(client, clean)
        const offer = catalog.offers.find((candidate) => candidate.providerProductId === req.productId && candidate.location === req.location)
        if (!offer || !offer.operatingSystems.some((os) => os.id === req.operatingSystem) || decimal(req.billingOption.amount) !== offer.billingOptions[0]?.amount) continue
        let data: ApiObject
        try {
          // Exactly one dispatch on this account. Only proven capacity refusal
          // permits a second dispatch; timeouts/5xx never leave this catch.
          data = await client.request('POST', '/servers', {
            name: hostname, server_type: req.productId.split(':')[0], location: req.location, image: Number(req.operatingSystem),
            start_after_create: true,
            public_net: { enable_ipv4: true, enable_ipv6: true },
            labels: { 'tofan-operation': label },
          })
        } catch (error) {
          if (error instanceof HetznerApiError && error.capacity) { capacity = error; continue }
          throw error
        }
        const view = mapServer(account, object(data.server))
        return {
          providerOrderId: view.providerServerId, providerServerId: view.providerServerId,
          state: view.state === 'active' ? 'active' : 'pending',
          metadata: { operationLabel: label },
        }
      }
      if (capacity) throw capacity
      throw new ProviderPermanentError('Hetzner has no active account with this available product, image and exact price')
    },
    async getServer(providerServerId) {
      const route = owner(providerServerId)
      const data = await clientFor(route.account).request('GET', `/servers/${route.id}`)
      const view = mapServer(route.account, object(data.server))
      if (view.providerServerId !== route.composite) throw new ProviderUnknownError('Hetzner lookup returned a different server')
      return view
    },
    async listServers() {
      const result: ProviderServerView[] = []
      for (const account of accounts) {
        if (!clients.has(account.id)) continue
        for (const server of await clientFor(account).pages('/servers', 'servers')) result.push(mapServer(account, server))
      }
      return result
    },
    powerOn(providerServerId) { return action(providerServerId, 'poweron') },
    powerOff(providerServerId) { return action(providerServerId, 'poweroff') },
    reboot(providerServerId) { return action(providerServerId, 'reboot') },
    async reconcileOrder(input): Promise<RecoveryResult> {
      const known = input.knownProviderServerId ?? input.knownProviderOrderId
      if (known) {
        try {
          const server = await this.getServer(known)
          return { resolution: 'MATCHED', providerServerId: server.providerServerId, providerOrderId: server.providerServerId, reason: 'Exact server id captured from the original operation was verified on its owning account' }
        } catch (error) {
          if (error instanceof HetznerApiError && error.httpStatus === 404) return { resolution: 'NO_MATCH', reason: 'Exact captured server id is absent on its owning account' }
          return { resolution: 'AMBIGUOUS', reason: 'Original owning account/server lookup could not be verified' }
        }
      }
      const reference = input.requested?.clientReference
      if (!reference) return { resolution: 'AMBIGUOUS', reason: 'No exact operation reference; hostname matching is not ownership proof' }
      const label = operationLabel(reference)
      const matches: ProviderServerView[] = []
      let unreadable = false
      for (const account of accounts) {
        if (!clients.has(account.id)) { unreadable = true; continue }
        try {
          const servers = await clientFor(account).pages(`/servers?label_selector=${encodeURIComponent(`tofan-operation=${label}`)}`, 'servers')
          for (const server of servers) {
            if (object(server.labels)['tofan-operation'] === label) matches.push(mapServer(account, server))
          }
        } catch { unreadable = true }
      }
      if (matches.length === 1 && !unreadable) {
        const match = matches[0]!
        return { resolution: 'MATCHED', providerServerId: match.providerServerId, providerOrderId: match.providerServerId, reason: 'Provider inventory carries the exact cryptographic operation-reference label' }
      }
      return {
        resolution: 'AMBIGUOUS',
        candidates: matches.map((server) => ({ providerServerId: server.providerServerId, hostname: server.hostname, state: server.state })),
        reason: unreadable ? 'Not every configured owning account could be read' : matches.length ? 'Multiple resources carry the operation label' : 'No operation label found; a dispatched create may still be in progress',
      }
    },
  }
}
