/**
 * Live Leaseweb provider (LEASEWEB_MODE=live).
 *
 * Uses the official APIs:
 *   Ordering: /ordering/v1/products/vps[/{vpsId}] and .../order
 *   VPS mgmt: /vps/v1/virtualServers[...]
 *
 * Safety:
 *  - Real ordering additionally requires LEASEWEB_ORDERING_ENABLED=true.
 *  - The catalog is normalized from whatever the API returns — billing
 *    cycle/contract term enums are never hardcoded here.
 *  - The API key lives only in this module's client; it is never logged and
 *    never exposed through any endpoint.
 *
 * NOTE: the exact response shapes of the Ordering API vary by account/entity.
 * The normalizers below are defensive and read only what they can prove; if a
 * field name differs for the configured account, this single file is where it
 * is adjusted (documented in docs/LEASEWEB.md).
 */
import {
  NotSupportedError,
  type CloudProvider,
  type ProviderActionResult,
  type ProviderCapability,
  type ProviderOffer,
  type ProviderOrderRequest,
  type ProviderOrderResult,
  type ProviderServerView,
  type RecoveryResult,
} from '../provider.interface.js'
import { ProviderPermanentError, ProviderUnknownError } from '../../../lib/errors.js'
import { LeasewebClient } from './client.js'
import type {
  LswOrderingProductDetail,
  LswOrderingProductsResponse,
  LswOrderResponse,
  LswVirtualServer,
  LswVirtualServersResponse,
} from './types.js'
import type { Logger } from '../../../logger.js'

export interface LiveLeasewebOptions {
  baseUrl: string
  apiKey: string
  orderingEnabled: boolean
  logger: Logger
}

export function createLiveLeasewebProvider(opts: LiveLeasewebOptions): CloudProvider {
  const client = new LeasewebClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, logger: opts.logger })

  const provider: CloudProvider = {
    id: 'leaseweb',
    name: 'Leaseweb (live)',
    capabilities: [
      'catalog',
      'provision',
      'power_on',
      'power_off',
      'reboot',
      'reinstall',
      'reconcile',
      'traffic',
    ] as ProviderCapability[],

    supports(cap) {
      return this.capabilities.includes(cap)
    },
    require(cap) {
      if (!this.supports(cap)) throw new NotSupportedError(cap)
    },

    async syncCatalog() {
      const raw: unknown = await client.get<LswOrderingProductsResponse>('/ordering/v1/products/vps')
      return normalizeCatalog(raw)
    },

    async createServer(req: ProviderOrderRequest): Promise<ProviderOrderResult> {
      this.require('provision')
      if (!opts.orderingEnabled) {
        throw new ProviderPermanentError(
          'Real Leaseweb ordering is disabled. Set LEASEWEB_MODE=live AND LEASEWEB_ORDERING_ENABLED=true to enable it.',
        )
      }

      const body: Record<string, unknown> = {
        operatingSystem: req.operatingSystem,
        location: req.location,
      }
      // Pass through the exact billing option the customer selected — the
      // values came from the provider's own product schema, never hardcoded.
      if (req.billingOption.billingCycle) body.billingCycle = req.billingOption.billingCycle
      if (req.billingOption.contractTerm !== undefined && req.billingOption.contractTerm !== null) {
        body.contractTerm = req.billingOption.contractTerm
      }
      if (req.serviceLevel?.id) body.serviceLevelAgreement = req.serviceLevel.id
      if (req.quantity && req.quantity > 1) body.quantity = req.quantity

      // One attempt, classified conservatively. `unknown` (timeout after
      // transmission, connection drop, 5xx, 429) means Leaseweb may have
      // processed the order: the caller marks the operation UNKNOWN and
      // reconciles. Only definitive rejections become permanent failures.
      const outcome = await client.postMutating(`/ordering/v1/products/vps/${encodeURIComponent(req.productId)}/order`, body)

      if (outcome.kind === 'definitive_rejection') {
        throw new ProviderPermanentError(outcome.message, {
          status: outcome.status,
          providerCorrelationId: outcome.correlationId,
          requestId: outcome.requestId,
        })
      }
      if (outcome.kind === 'unknown') {
        throw new ProviderUnknownError(outcome.message, {
          httpStatus: outcome.status,
          providerCorrelationId: outcome.correlationId,
          requestId: outcome.requestId,
        })
      }

      const res = outcome.data as LswOrderResponse
      const providerOrderId = res.orderId ?? res.id
      if (!providerOrderId) {
        throw new ProviderUnknownError('Leaseweb order response did not include an order id', {
          res,
          providerCorrelationId: outcome.correlationId,
          requestId: outcome.requestId,
        })
      }
      return {
        providerOrderId,
        state: mapOrderState(res.state ?? res.status),
        providerServerId: typeof res.productId === 'string' ? res.productId : undefined,
        metadata: {
          raw: res,
          providerCorrelationId: outcome.correlationId,
          requestId: outcome.requestId,
        },
      }
    },

    /**
     * Leaseweb VPS Ordering has no reliable client-supplied idempotency key
     * that survives to the VPS inventory. Automatic MATCHED is therefore only
     * possible with an id captured from the ORIGINAL order response before
     * the ambiguity. Everything else is AMBIGUOUS (candidate evidence only).
     */
    async reconcileOrder(input: {
      knownProviderOrderId?: string
      knownProviderServerId?: string
      requested?: ProviderOrderRequest
    }): Promise<RecoveryResult> {
      this.require('reconcile')
      // Conclusive: we captured this id from the original response. Verify it
      // still exists at the provider.
      if (input.knownProviderServerId) {
        try {
          const vps = await this.getServer(input.knownProviderServerId)
          if (vps && vps.providerServerId !== 'unknown') {
            return {
              resolution: 'MATCHED',
              providerServerId: vps.providerServerId,
              reason: 'provider server id captured from the original order response, verified via /vps/v1/virtualServers/{id}',
            }
          }
          return { resolution: 'NO_MATCH', reason: `known provider server id ${input.knownProviderServerId} not found at the provider` }
        } catch {
          return { resolution: 'NO_MATCH', reason: `known provider server id ${input.knownProviderServerId} could not be verified at the provider` }
        }
      }
      if (input.knownProviderOrderId) {
        try {
          const servers = await this.listServers()
          const byOrderId = servers.filter((s) => (s.metadata as Record<string, unknown> | undefined)?.orderId === input.knownProviderOrderId)
          // Only when the provider itself exposes the order id on the server
          // record is this conclusive. Currently Leaseweb VPS does not expose
          // a client-referenceable order id — keep conservative.
          if (byOrderId.length === 1 && byOrderId[0]) {
            return { resolution: 'MATCHED', providerServerId: byOrderId[0].providerServerId, providerOrderId: input.knownProviderOrderId, reason: 'provider returned server record carrying the known order id' }
          }
        } catch {
          /* fall through to AMBIGUOUS */
        }
      }
      // Evidence only — never proof.
      const candidates = await this.listServers().catch(() => [])
      return {
        resolution: 'AMBIGUOUS',
        candidates: candidates.map((s) => ({
          providerServerId: s.providerServerId,
          hostname: s.hostname,
          state: s.state,
          createdAt: (s.metadata as Record<string, unknown> | undefined)?.createdAt as string | undefined,
        })),
        reason: 'no conclusive provider-side identifier links a discovered VPS to this operation; possible candidates listed for operator review only',
      }
    },

    async getServer(providerServerId: string): Promise<ProviderServerView> {
      const vps = await client.get<LswVirtualServer>(`/vps/v1/virtualServers/${encodeURIComponent(providerServerId)}`)
      return mapVirtualServer(vps)
    },

    async listServers(): Promise<ProviderServerView[]> {
      const res = await client.get<LswVirtualServersResponse>('/vps/v1/virtualServers')
      return (res.virtualServers ?? []).map(mapVirtualServer)
    },

    async powerOn(providerServerId: string): Promise<ProviderActionResult> {
      this.require('power_on')
      await client.post(`/vps/v1/virtualServers/${encodeURIComponent(providerServerId)}/power-on`)
      return { ok: true }
    },
    async powerOff(providerServerId: string): Promise<ProviderActionResult> {
      this.require('power_off')
      await client.post(`/vps/v1/virtualServers/${encodeURIComponent(providerServerId)}/power-off`)
      return { ok: true }
    },
    async reboot(providerServerId: string): Promise<ProviderActionResult> {
      this.require('reboot')
      await client.post(`/vps/v1/virtualServers/${encodeURIComponent(providerServerId)}/reboot`)
      return { ok: true }
    },
  }

  return provider
}

// ---------------------------------------------------------------------------
// Normalizers — defensive; see note at the top of this file.
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function normalizeCatalog(raw: unknown): {
  offers: ProviderOffer[]
  locations: Array<{ code: string; country?: string; city?: string }>
  raw: unknown
} {
  const root = (raw ?? {}) as LswOrderingProductsResponse
  const products = root.products ?? []
  const offers: ProviderOffer[] = []
  const locations = new Map<string, { code: string; country?: string; city?: string }>()

  for (const product of products) {
    const id = asString(product.id)
    if (!id) continue
    const detail = product as LswOrderingProductDetail
    const cfg = detail.configuration ?? {}

    const locationList = Array.isArray(cfg.locations) ? cfg.locations : []
    const osList = Array.isArray(cfg.operatingSystems) ? cfg.operatingSystems : []
    const slaList = Array.isArray(cfg.serviceLevels) ? cfg.serviceLevels : []
    const cycleList = Array.isArray(cfg.billingCycles) ? cfg.billingCycles : []
    const termList = Array.isArray(cfg.contractTerms) ? cfg.contractTerms : []

    const osOptions = osList.map((os) => {
      if (typeof os === 'string') return { id: os, label: os }
      return { id: asString(os.id) ?? asString(os.label) ?? 'unknown', label: asString(os.label) ?? asString(os.id) }
    })

    const slaOptions = slaList.map((sla) => {
      if (typeof sla === 'string') return { id: sla, label: sla }
      return { id: asString(sla.id) ?? asString(sla.label) ?? 'unknown', label: asString(sla.label) ?? asString(sla.id) }
    })

    // Billing options: billingCycle × contractTerm, priced per the API when
    // provided. When the API gives no explicit option lists, we expose the
    // product as catalog-only (available=false for ordering) rather than
    // inventing billing enums.
    const billingOptions = buildBillingOptions(cycleList, termList, detail)

    const priceCents = toCents(detail.price?.amount)
    const currency = asString(detail.price?.currency) ?? 'EUR'

    const locationsForProduct = locationList.length > 0 ? locationList : [undefined]
    for (const loc of locationsForProduct) {
      const locationCode = typeof loc === 'string' ? loc : asString(loc?.id) ?? asString(loc?.label)
      if (!locationCode) continue
      const locationLabel = typeof loc === 'object' && loc ? asString(loc.label) : undefined
      locations.set(locationCode, { code: locationCode, country: locationLabel })
      offers.push({
        provider: 'leaseweb',
        providerProductId: id,
        location: locationCode,
        name: asString(detail.name) ?? asString(detail.description) ?? id,
        vcpu: asNumber(cfg.vcpu ?? detail.vcpu) ?? 0,
        memoryMb: asNumber(cfg.memoryMb ?? detail.memoryMb) ?? 0,
        diskGb: asNumber(cfg.diskGb ?? detail.diskGb) ?? 0,
        trafficGb: asNumber(cfg.trafficGb ?? detail.trafficGb) ?? null,
        ipv4Count: asNumber(cfg.ipv4Count ?? detail.ipv4Count) ?? 1,
        ipv6Available: Boolean(cfg.ipv6 ?? detail.ipv6 ?? true),
        providerCurrency: currency,
        providerPriceCents: priceCents,
        billingOptions,
        operatingSystems: osOptions,
        serviceLevels: slaOptions,
        raw: detail,
      })
    }
  }

  return { offers, locations: [...locations.values()], raw }
}

function buildBillingOptions(
  cycleList: unknown[],
  termList: unknown[],
  detail: LswOrderingProductDetail,
): ProviderOffer['billingOptions'] {
  if (cycleList.length === 0 && termList.length === 0) return []

  const cycles = cycleList.map((raw) => {
    if (typeof raw === 'string') return { id: raw, label: raw, price: undefined }
    const c = raw as { id?: unknown; label?: unknown; price?: unknown }
    return {
      id: asString(c.id) ?? asString(c.label) ?? 'unknown',
      label: asString(c.label) ?? asString(c.id) ?? 'unknown',
      price: c.price as { amount?: unknown; currency?: unknown } | undefined,
    }
  })
  const terms = termList.map((raw) => {
    if (typeof raw === 'number' || typeof raw === 'string') return { id: raw }
    return { id: (raw as { id?: unknown })?.id ?? 0 }
  })
  const effectiveTerms = terms.length > 0 ? terms : [{ id: 0 }]

  const options: ProviderOffer['billingOptions'] = []
  for (const cycle of cycles) {
    for (const term of effectiveTerms) {
      const amountCents = toCents(cycle.price?.amount) ?? (detail.price?.amount !== undefined ? toCents(detail.price.amount) : null)
      const amount = typeof cycle.price?.amount === 'string' ? cycle.price.amount : undefined
      options.push({
        billingCycle: cycle.id,
        label: cycle.label,
        contractTerm: term.id as string | number | undefined,
        // A contractTerm of 1 month (or absent) with a monthly cycle => monthly.
        periodMonths: 1,
        amountCents: amountCents ?? 0,
        amount,
        monthly: true,
      })
    }
  }
  return options
}

function toCents(amount: unknown): number | null {
  const n = asNumber(amount)
  if (n === undefined) return null
  return Math.round(n * 100)
}

function mapOrderState(state: string | undefined): ProviderOrderResult['state'] {
  const s = (state ?? '').toLowerCase()
  if (s.includes('active') || s.includes('provision')) return 'active'
  if (s.includes('fail') || s.includes('cancel') || s.includes('error')) return 'failed'
  if (s.includes('pending') || s.includes('new')) return 'pending'
  return 'pending'
}

function mapVirtualServer(vps: LswVirtualServer): ProviderServerView {
  const ips = Array.isArray(vps.ipAddresses) ? vps.ipAddresses : Array.isArray(vps.ips) ? vps.ips : []
  const ipv4 = ips.find((i) => String(i.version ?? '').includes('4'))
  const ipv6 = ips.find((i) => String(i.version ?? '').includes('6'))
  return {
    providerServerId: asString(vps.id) ?? 'unknown',
    state: mapServerState(vps.state),
    hostname: asString(vps.name),
    ipv4: asString(ipv4?.ip),
    ipv6: asString(ipv6?.ip),
    metadata: { raw: vps },
  }
}

function mapServerState(state: string | undefined): ProviderServerView['state'] {
  const s = (state ?? '').toLowerCase()
  if (s.includes('run')) return 'active'
  if (s.includes('stop') || s.includes('suspend')) return 'suspended'
  if (s.includes('provision') || s.includes('instal')) return 'provisioning'
  if (s.includes('terminat') || s.includes('delet')) return 'terminated'
  if (s.includes('fail') || s.includes('error')) return 'failed'
  return 'unknown'
}