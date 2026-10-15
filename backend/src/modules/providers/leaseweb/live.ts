/** Leaseweb VPS Ordering and hourly Public Cloud, with credential-pinned ids. */
import type { LeasewebConfig, ProviderAccount } from '../../../config.js'
import type { Logger } from '../../../logger.js'
import { ProviderPermanentError, ProviderUnknownError } from '../../../lib/errors.js'
import {
  NotSupportedError,
  type CloudProvider,
  type ProviderActionResult,
  type ProviderOffer,
  type ProviderOrderResult,
  type ProviderServerView,
} from '../provider.interface.js'
import { LeasewebClient } from './client.js'
import { items, normalizeVpsDetail, numeric, record, sameDecimal, text, type LeasewebRecord } from './catalog.js'
import { cloudCreateBody, cloudLocationAllowed, isCatalogExclusion, readCloudCatalog } from './cloud.js'
import { requireMutationSuccess } from './safety.js'

export { normalizeCatalog } from './catalog.js'
export type LiveLeasewebOptions = LeasewebConfig & { logger: Logger }
type Family = 'vps' | 'cloud'
type AccountClient = { account: ProviderAccount; client: LeasewebClient }

function compositeId(accountId: string, family: Family, nativeId: string): string {
  return `lsw:${encodeURIComponent(accountId)}:${family}:${encodeURIComponent(nativeId)}`
}

/** Consume every page or fail the entire census, never a silently truncated list. */
async function readPages(client: LeasewebClient, path: string, keys: string[]): Promise<LeasewebRecord[]> {
  const result: LeasewebRecord[] = []
  let offset = 0
  for (let page = 0; page < 100; page++) {
    const payload = await client.get<unknown>(`${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`)
    if (!Array.isArray(payload) && !keys.some((key) => Array.isArray(record(payload)[key]))) throw new ProviderPermanentError('Leaseweb collection response has an unrecognized shape; refusing an incomplete census')
    const rows = items(payload, ...keys)
    result.push(...rows)
    const total = record(record(payload)._metadata).totalCount
    if (!rows.length && typeof total === 'number' && result.length < total) throw new ProviderPermanentError('Leaseweb collection ended before its declared total; refusing an incomplete census')
    if (!rows.length || (typeof total === 'number' ? result.length >= total : rows.length < 100)) return result
    offset += rows.length
  }
  throw new ProviderPermanentError('Leaseweb collection exceeded the pagination safety bound; catalog/inventory is incomplete')
}

async function vpsCatalog(client: LeasewebClient, configured: string[]): Promise<ProviderOffer[]> {
  const offers: ProviderOffer[] = []
  const locations = new Set(configured)
  if (!locations.size) {
    // Ordering has no location-list endpoint: discover only provider-returned
    // locations; never publish a configured seed without a successful read.
    for (const row of await readPages(client, '/ordering/v1/products/vps', ['vpss', 'products', 'data', 'items'])) {
      const declared = Array.isArray(row.location) ? row.location : [row.location]
      for (const location of declared) if (text(location)) locations.add(text(location)!)
    }
  }
  for (const location of locations) {
    try {
      const products = await readPages(client, `/ordering/v1/products/vps?location=${encodeURIComponent(location)}`, ['vpss', 'products', 'data', 'items'])
      for (const product of products) {
        const id = text(product.id)
        if (!id) throw new ProviderPermanentError('Leaseweb product list omitted a product identity')
        try {
          // The explicit requested pair is proved by this successful detail
          // query. Independent contractTerms/billingCycles lists are NOT paired.
          const selected = { contractTerm: '1_MONTH', billingCycle: '1_MONTH' }
          const detail = await client.get<unknown>(`/ordering/v1/products/vps/${encodeURIComponent(id)}?${new URLSearchParams({ location, ...selected })}`)
          const offer = normalizeVpsDetail(detail, location, selected)
          if (offer && offer.providerCurrency && offer.billingOptions.length && offer.operatingSystems.length) offers.push(offer)
        } catch (error) {
          if (!isCatalogExclusion(error)) throw error
        }
      }
    } catch (error) {
      // Account/site exclusions are authoritative; a timeout/429/5xx is NOT an
      // empty catalog and must fail sync so existing scopes are not retired.
      if (!isCatalogExclusion(error)) throw error
    }
  }
  return offers
}

function mapServer(raw: unknown, providerServerId: string): ProviderServerView {
  const envelope = record(raw)
  const server = record(envelope.instance ?? envelope.vps ?? raw)
  const state = String(server.state ?? server.status ?? '').toLowerCase()
  let mapped: ProviderServerView['state'] = 'unknown'
  if (['running', 'active', 'started', 'available'].includes(state)) mapped = 'active'
  else if (['stopped', 'suspended', 'off', 'powered-off'].includes(state)) mapped = 'suspended'
  else if (/provision|creat|install|build|starting|reboot/.test(state)) mapped = 'provisioning'
  else if (/terminat|delet/.test(state)) mapped = 'terminated'
  else if (/fail|error/.test(state)) mapped = 'failed'
  const addresses = items(server.ipAddresses ?? server.ips)
  let ipv4: string | undefined
  let ipv6: string | undefined
  for (const address of addresses) {
    const ip = text(address.ip ?? address.address)
    if (!ip || (address.networkType !== undefined && !/public/i.test(String(address.networkType)))) continue
    if (ip.includes(':')) ipv6 ??= ip
    else ipv4 ??= ip
  }
  const resources = record(server.resources)
  return {
    providerServerId,
    state: mapped,
    hostname: text(server.reference ?? server.name),
    ipv4,
    ipv6,
    vcpu: numeric(record(resources.cpu).value) || undefined,
    memoryMb: numeric(record(resources.memory).value) ? numeric(record(resources.memory).value) * 1024 : undefined,
    diskGb: numeric(server.rootDiskSize) || undefined,
    metadata: { raw: server },
  }
}

export function createLiveLeasewebProvider(opts: LiveLeasewebOptions): CloudProvider {
  const primaryId = opts.accounts[0]?.id
  const clients = new Map<string, AccountClient>()
  for (const account of opts.accounts) {
    if (!account.apiKey) continue
    if (clients.has(account.id)) throw new ProviderPermanentError('Duplicate Leaseweb account id')
    clients.set(account.id, { account, client: new LeasewebClient({ baseUrl: opts.baseUrl, apiKey: account.apiKey, logger: opts.logger }) })
  }
  const ranked = [...clients.values()].filter(({ account }) => account.enabled && account.state.toLowerCase() === 'active')
    .sort((a, b) => a.account.priority - b.account.priority || a.account.id.localeCompare(b.account.id))

  function owner(id: string): AccountClient & { family: Family; nativeId: string } {
    let accountId = primaryId
    let family: Family = 'vps'
    let nativeId = id
    const qualified = id.startsWith('lsw:')
    if (qualified) {
      const parts = id.split(':')
      if (parts.length !== 4 || !['vps', 'cloud'].includes(parts[2]!)) throw new ProviderPermanentError('Invalid Leaseweb resource identity')
      try {
        accountId = decodeURIComponent(parts[1]!)
        nativeId = decodeURIComponent(parts[3]!)
      } catch {
        throw new ProviderPermanentError('Invalid Leaseweb resource identity encoding')
      }
      family = parts[2] as Family
    }
    const accountClient = accountId ? clients.get(accountId) : undefined
    if (!accountClient || !nativeId) throw new ProviderPermanentError('The owning Leaseweb credential is unavailable; refusing account fallback')
    return { ...accountClient, family, nativeId }
  }

  async function action(id: string, operation: 'start' | 'stop' | 'reboot'): Promise<ProviderActionResult> {
    const selected = owner(id)
    const collection = selected.family === 'cloud' ? 'instances' : 'vps'
    const outcome = await selected.client.postMutating(`/publicCloud/v1/${collection}/${encodeURIComponent(selected.nativeId)}/${operation}`, undefined)
    requireMutationSuccess(outcome)
    return { ok: true, metadata: { providerCorrelationId: outcome.correlationId, requestId: outcome.requestId } }
  }

  const provider: CloudProvider = {
    id: 'leaseweb',
    name: opts.displayName,
    capabilities: ['catalog', 'provision', 'power_on', 'power_off', 'reboot', 'reconcile'],
    supports(capability) {
      return this.capabilities.includes(capability)
    },
    require(capability) {
      if (!this.supports(capability)) throw new NotSupportedError(capability)
    },

    async syncCatalog() {
      const offers = new Map<string, ProviderOffer>()
      const locations = new Map<string, { code: string; country?: string; city?: string }>()
      for (const { account, client } of ranked) {
        const discovered: ProviderOffer[] = []
        if (opts.families.vps.enabled) {
          try {
            discovered.push(...await vpsCatalog(client, opts.locations))
          } catch (error) {
            if (!isCatalogExclusion(error)) throw error
          }
        }
        if (opts.families.cloud.enabled) {
          try {
            const cloud = await readCloudCatalog(client, opts.locations)
            discovered.push(...cloud.offers)
            for (const location of cloud.locations) if (!locations.has(location.code)) locations.set(location.code, location)
          } catch (error) {
            if (!isCatalogExclusion(error)) throw error
          }
        }
        for (const offer of discovered) {
          const family = offer.category === 'cloud' ? 'cloud' : 'vps'
          const key = `${family}:${offer.providerProductId}:${offer.location}`
          if (offers.has(key)) continue
          offers.set(key, { ...offer, providerProductId: compositeId(account.id, family, offer.providerProductId) })
          if (!locations.has(offer.location)) locations.set(offer.location, { code: offer.location })
        }
      }
      return { offers: [...offers.values()], locations: [...locations.values()], raw: { offerCount: offers.size, locationCount: locations.size } }
    },

    async createServer(req): Promise<ProviderOrderResult> {
      // Local guard precedes every provider read as well as the paid POST.
      if (!opts.enabled || !opts.orderingEnabled) throw new ProviderPermanentError('Real Leaseweb ordering is disabled by provider configuration')
      if (req.quantity !== undefined && req.quantity !== 1) throw new ProviderPermanentError('Leaseweb ordering supports one server per operation')
      const selected = owner(req.productId)
      if (!selected.account.enabled || selected.account.state.toLowerCase() !== 'active') throw new ProviderPermanentError('The owning Leaseweb account is not accepting new orders')
      if (!opts.families[selected.family].enabled) throw new ProviderPermanentError('This Leaseweb product family is disabled')
      if (selected.family === 'cloud' ? !cloudLocationAllowed(req.location, opts.locations) : opts.locations.length && !opts.locations.includes(req.location)) throw new ProviderPermanentError('This Leaseweb location is not enabled')
      const nativeRequest = { ...req, productId: selected.nativeId }
      let path: string
      let body: LeasewebRecord
      if (selected.family === 'cloud') {
        body = await cloudCreateBody(selected.client, nativeRequest)
        path = '/publicCloud/v1/instances'
      } else {
        const query = new URLSearchParams({ location: req.location, billingCycle: req.billingOption.billingCycle, operatingSystem: req.operatingSystem })
        if (req.billingOption.contractTerm !== undefined) query.set('contractTerm', String(req.billingOption.contractTerm))
        if (req.serviceLevel?.id) query.set('serviceLevelAgreement', req.serviceLevel.id)
        const detail = await selected.client.get<unknown>(`/ordering/v1/products/vps/${encodeURIComponent(selected.nativeId)}?${query}`)
        const live = normalizeVpsDetail(detail, req.location, req.billingOption)
        if (!live || !live.operatingSystems.some((os) => os.id === req.operatingSystem)) throw new ProviderPermanentError('Leaseweb VPS product or free operating system is no longer available')
        const liveOption = live.billingOptions.find((option) => option.billingCycle === req.billingOption.billingCycle && String(option.contractTerm) === String(req.billingOption.contractTerm))
        const requestedAmount = req.billingOption.amount ?? (req.billingOption.amountCents === undefined ? undefined : String(req.billingOption.amountCents / 100))
        if (!liveOption || !sameDecimal(liveOption.amount, requestedAmount)) throw new ProviderPermanentError('Leaseweb VPS price or contract changed; select the current offer')
        if (req.serviceLevel && !live.serviceLevels.some((sla) => sla.id === req.serviceLevel!.id)) throw new ProviderPermanentError('Leaseweb VPS service level is unavailable at this price')
        body = { location: req.location, operatingSystem: req.operatingSystem, billingCycle: req.billingOption.billingCycle }
        if (req.billingOption.contractTerm !== undefined) body.contractTerm = req.billingOption.contractTerm
        if (req.serviceLevel?.id) body.serviceLevelAgreement = req.serviceLevel.id
        path = `/ordering/v1/products/vps/${encodeURIComponent(selected.nativeId)}/order`
      }
      // Never change credentials after any mutation, including ambiguous
      // timeout/5xx/429 outcomes. A composite id has exactly one owner.
      const outcome = await selected.client.postMutating(path, body)
      const raw = requireMutationSuccess(outcome)
      const response = record(raw)
      const result = record(response.instance ?? response)
      const nativeOrderId = selected.family === 'cloud' ? text(result.id) : text(result.orderId)
      if (!nativeOrderId) throw new ProviderUnknownError('Leaseweb accepted the request without an identifiable result', { providerCorrelationId: outcome.correlationId, requestId: outcome.requestId })
      return {
        providerOrderId: compositeId(selected.account.id, selected.family, nativeOrderId),
        providerServerId: selected.family === 'cloud' ? compositeId(selected.account.id, 'cloud', nativeOrderId) : undefined,
        state: selected.family === 'cloud' && mapServer(result, nativeOrderId).state === 'active' ? 'active' : 'pending',
        metadata: { raw, providerCorrelationId: outcome.correlationId, requestId: outcome.requestId },
      }
    },

    async getServer(id) {
      const selected = owner(id)
      const collection = selected.family === 'cloud' ? 'instances' : 'vps'
      const response = await selected.client.get<unknown>(`/publicCloud/v1/${collection}/${encodeURIComponent(selected.nativeId)}`)
      const server = record(record(response).instance ?? record(response).vps ?? response)
      if (text(server.id) !== selected.nativeId) throw new ProviderPermanentError('Leaseweb returned a different or missing server identity')
      // Preserve bare resource identity for existing primary-account rows.
      return mapServer(server, id)
    },

    async listServers() {
      const servers: ProviderServerView[] = []
      for (const { account, client } of clients.values()) {
        // Disabled accounts are still the owners of existing resources.
        for (const family of ['vps', 'cloud'] as const) {
          try {
            const collection = family === 'cloud' ? 'instances' : 'vps'
            const rows = await readPages(client, `/publicCloud/v1/${collection}`, [collection, 'virtualServers', 'data', 'items'])
            for (const row of rows) {
              const id = text(row.id)
              if (id) servers.push(mapServer(row, compositeId(account.id, family, id)))
            }
          } catch (error) {
            if (!isCatalogExclusion(error)) throw error
          }
        }
      }
      return servers
    },

    async powerOn(id) { return action(id, 'start') },
    async powerOff(id) { return action(id, 'stop') },
    async reboot(id) { return action(id, 'reboot') },

    async reconcileOrder(input) {
      if (input.knownProviderServerId) {
        try {
          const server = await this.getServer(input.knownProviderServerId)
          return { resolution: 'MATCHED', providerServerId: server.providerServerId, reason: 'Original response server identity verified with its owning account' }
        } catch {
          return { resolution: 'AMBIGUOUS', reason: 'Original server identity cannot currently be verified; absence is not proof of non-creation' }
        }
      }
      const identity = input.knownProviderOrderId ?? input.requested?.productId
      if (!identity) return { resolution: 'AMBIGUOUS', reason: 'No account-pinned operation identity is available' }
      const selected = owner(identity)
      if (selected.family === 'cloud') {
        if (input.knownProviderOrderId) {
          try {
            const serverId = compositeId(selected.account.id, 'cloud', selected.nativeId)
            await this.getServer(serverId)
            return { resolution: 'MATCHED', providerServerId: serverId, providerOrderId: input.knownProviderOrderId, reason: 'Original Cloud response instance identity verified' }
          } catch {
            return { resolution: 'AMBIGUOUS', reason: 'Cloud response identity could not be verified' }
          }
        }
        const reference = input.requested?.clientReference
        const region = input.requested?.location
        if (reference && reference.length <= 64 && region) {
          try {
            const rows = await readPages(selected.client, `/publicCloud/v1/instances?region=${encodeURIComponent(region)}`, ['instances', 'data', 'items'])
            const matches = rows.filter((server) => text(server.reference) === reference && text(server.region) === region && text(server.type ?? server.instanceType) === selected.nativeId && text(server.imageId ?? server.image) === input.requested?.operatingSystem && text(server.id))
            if (matches.length === 1) {
              const id = compositeId(selected.account.id, 'cloud', text(matches[0]!.id)!)
              return { resolution: 'MATCHED', providerServerId: id, providerOrderId: id, reason: 'Unique deterministic client reference and launch facts verified on the owning credential' }
            }
          } catch {
            return { resolution: 'AMBIGUOUS', reason: 'Cloud reference lookup was inconclusive; do not re-order' }
          }
        }
      } else if (input.knownProviderOrderId) {
        try {
          const response = await selected.client.get<unknown>(`/account/v1/orders/${encodeURIComponent(selected.nativeId)}`)
          const order = record(record(response).order ?? response)
          const services = items(order, 'services').filter((service) => service.productId === 'VIRTUAL_SERVER')
          const equipmentIds = new Set(services.flatMap((service) => text(service.equipmentId) ? [text(service.equipmentId)!] : []))
          if (equipmentIds.size === 1) {
            const id = compositeId(selected.account.id, 'vps', [...equipmentIds][0]!)
            await this.getServer(id)
            return { resolution: 'MATCHED', providerServerId: id, providerOrderId: input.knownProviderOrderId, reason: 'Exact equipment identity from the original account order verified in VPS inventory' }
          }
        } catch {
          return { resolution: 'AMBIGUOUS', reason: 'Original order equipment identity could not be verified' }
        }
      }
      return { resolution: 'AMBIGUOUS', reason: 'No conclusive account-pinned provider identity links inventory to this operation; manual review required' }
    },
  }
  return provider
}
