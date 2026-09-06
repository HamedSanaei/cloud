/**
 * Mock Leaseweb provider (LEASEWEB_MODE=mock, the default).
 *
 * Simulates the Leaseweb Ordering API + VPS management API in-memory:
 *  - Realistic catalog fixtures (see fixtures.ts).
 *  - Provisioning that "creates" a VPS with deterministic IDs.
 *  - Test hooks to simulate retryable failures, permanent failures and the
 *    dangerous "request dispatched, response lost" (timeout-after-dispatch)
 *    case so provisioning/reconciliation code can be verified without money.
 *
 * Never touches the network. CI can always use this provider.
 */
import { randomUUID } from 'node:crypto'
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
import { ProviderPermanentError, ProviderRetryableError, ProviderUnknownError } from '../../../lib/errors.js'
import { buildMockOffers, MOCK_LOCATIONS, MOCK_RAW_SYNC } from './fixtures.js'

export interface MockBehavior {
  /** If set, the next N createServer calls fail with this kind of error. */
  failNextOrders?: 'retryable' | 'permanent'
  failNextOrdersCount?: number
  /** If true, next createServer throws ProviderUnknownError (dispatch reached the provider). */
  timeoutNextOrders?: boolean
  /** Simulated provisioning delay per createServer call (ms). */
  provisionDelayMs?: number
}

interface MockVps {
  id: string
  name: string
  state: string
  ipv4: string
  ipv6: string
  product: ProviderOffer
  os: string
}

export interface MockLeasewebProvider extends CloudProvider {
  /** Test hook: mutate behavior (mock mode only). */
  setBehavior(behavior: Partial<MockBehavior>): void
  reset(): void
  /** Test-only: drop created servers (keeps behavior flags). */
  _clearServers(): void
  _vpsList(): MockVps[]
  /** Test-only: number of createServer POSTs ever received by this instance. */
  _postCount(): number
}

export function createMockLeasewebProvider(): MockLeasewebProvider {
  const offers = buildMockOffers()
  const vpsList = new Map<string, MockVps>()
  let behavior: MockBehavior = {}
  let postCount = 0

  function nextIpv4(): string {
    return `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 250) + 2}`
  }
  function nextIpv6(): string {
    const hex = () => Math.floor(Math.random() * 0xffff).toString(16)
    return `2a10:${hex()}:${hex()}::${hex()}:${hex()}`
  }

  const provider: MockLeasewebProvider = {
    id: 'leaseweb',
    name: 'Leaseweb (mock)',
    capabilities: [
      'catalog',
      'provision',
      'power_on',
      'power_off',
      'reboot',
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
      return {
        offers,
        locations: MOCK_LOCATIONS.map((l) => ({ code: l.code, country: l.country, city: l.city })),
        raw: MOCK_RAW_SYNC,
      }
    },

    async createServer(req: ProviderOrderRequest): Promise<ProviderOrderResult> {
      this.require('provision')
      postCount++

      if (behavior.timeoutNextOrders) {
        behavior.timeoutNextOrders = false
        // The provider received and processed the order, but our connection
        // died before we got the response. The operation must be marked
        // UNKNOWN and reconciled later — never re-ordered blindly.
        const phantomOrderId = `ord-${randomUUID()}`
        const phantomServerId = `vps-${randomUUID()}`
        const correlationId = `mock-correlation-${phantomOrderId}`
        // Simulate that the phantom server exists at the provider:
        const offer = offers.find((o) => o.providerProductId === req.productId && o.location === req.location)
        if (offer) {
          const vps: MockVps = {
            id: phantomServerId,
            name: req.hostname ?? `vps-${phantomServerId.slice(4, 12)}`,
            state: 'active',
            ipv4: nextIpv4(),
            ipv6: nextIpv6(),
            product: offer,
            os: req.operatingSystem,
          }
          vpsList.set(phantomServerId, vps)
        }
        throw new ProviderUnknownError('Leaseweb request dispatched but response was lost (simulated timeout)', {
          simulatedProviderOrderId: phantomOrderId,
          simulatedProviderServerId: phantomServerId,
          simulatedProviderCorrelationId: correlationId,
        })
      }

      if (behavior.failNextOrders && (behavior.failNextOrdersCount ?? 1) > 0) {
        const kind = behavior.failNextOrders
        behavior.failNextOrdersCount = (behavior.failNextOrdersCount ?? 1) - 1
        if (behavior.failNextOrdersCount === 0) behavior.failNextOrders = undefined
        if (kind === 'retryable') {
          throw new ProviderRetryableError('Leaseweb simulated transient failure (mock)', { retryable: true })
        }
        throw new ProviderPermanentError('Leaseweb simulated permanent rejection (mock)', { permanent: true })
      }

      if (behavior.provisionDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.provisionDelayMs))
      }

      const offer = offers.find((o) => o.providerProductId === req.productId && o.location === req.location)
      if (!offer) {
        throw new ProviderPermanentError(`Product ${req.productId}@${req.location} not available (mock)`)
      }
      const serverId = `vps-${randomUUID()}`
      const vps: MockVps = {
        id: serverId,
        name: req.hostname ?? `vps-${serverId.slice(4, 12)}`,
        state: 'active',
        ipv4: nextIpv4(),
        ipv6: nextIpv6(),
        product: offer,
        os: req.operatingSystem,
      }
      vpsList.set(serverId, vps)
      return {
        providerOrderId: `ord-${randomUUID()}`,
        state: 'active',
        providerServerId: serverId,
        metadata: { mock: true, ipv4: vps.ipv4, ipv6: vps.ipv6 },
      }
    },

    async reconcileOrder(input: {
      knownProviderOrderId?: string
      knownProviderServerId?: string
      requested?: { productId?: string; location?: string; operatingSystem?: string; hostname?: string }
    }): Promise<RecoveryResult> {
      this.require('reconcile')
      // CONCLUSIVE path: an id captured from the original response before the
      // ambiguity. Verify it exists at the provider — that is real proof.
      if (input.knownProviderServerId) {
        const vps = vpsList.get(input.knownProviderServerId)
        if (vps) {
          return {
            resolution: 'MATCHED',
            providerServerId: vps.id,
            providerOrderId: `ord-${vps.id}`,
            reason: 'provider server id captured from the original order response, verified to exist at the provider',
          }
        }
        return { resolution: 'NO_MATCH', reason: `known provider server id ${input.knownProviderServerId} does not exist at the provider` }
      }
      if (input.knownProviderOrderId) {
        // Mock cannot map order ids to servers reliably; treat as evidence only.
        const vps = [...vpsList.values()].find((v) => v.id === input.knownProviderOrderId)
        if (vps) {
          return { resolution: 'MATCHED', providerServerId: vps.id, providerOrderId: input.knownProviderOrderId, reason: 'provider order id maps to a server at the provider' }
        }
      }
      // Conservative: hostname/product/location similarity is EVIDENCE ONLY.
      const candidates = [...vpsList.values()]
        .filter((v) => !input.knownProviderServerId || v.id === input.knownProviderServerId)
        .map((v) => ({ providerServerId: v.id, hostname: v.name, state: v.state }))
      return {
        resolution: 'AMBIGUOUS',
        candidates,
        reason: 'no conclusive provider-side identifier links a discovered VPS to this operation; possible candidates listed for operator review only',
      }
    },

    async getServer(providerServerId: string): Promise<ProviderServerView> {
      const vps = vpsList.get(providerServerId)
      if (!vps) throw new ProviderPermanentError(`VPS ${providerServerId} not found (mock)`)
      return viewOf(vps)
    },

    async listServers(): Promise<ProviderServerView[]> {
      return [...vpsList.values()].map(viewOf)
    },

    async powerOn(providerServerId: string): Promise<ProviderActionResult> {
      this.require('power_on')
      const vps = vpsList.get(providerServerId)
      if (!vps) throw new ProviderPermanentError(`VPS ${providerServerId} not found (mock)`)
      vps.state = 'running'
      return { ok: true }
    },

    async powerOff(providerServerId: string): Promise<ProviderActionResult> {
      this.require('power_off')
      const vps = vpsList.get(providerServerId)
      if (!vps) throw new ProviderPermanentError(`VPS ${providerServerId} not found (mock)`)
      vps.state = 'stopped'
      return { ok: true }
    },

    async reboot(providerServerId: string): Promise<ProviderActionResult> {
      this.require('reboot')
      const vps = vpsList.get(providerServerId)
      if (!vps) throw new ProviderPermanentError(`VPS ${providerServerId} not found (mock)`)
      vps.state = 'running'
      return { ok: true }
    },

    setBehavior(next: Partial<MockBehavior>) {
      behavior = { ...behavior, ...next }
    },
    reset() {
      behavior = {}
      vpsList.clear()
      postCount = 0
    },
    /** Test-only: clear state without touching behavior flags. */
    _clearServers() {
      vpsList.clear()
    },
    _vpsList() {
      return [...vpsList.values()]
    },
    _postCount() {
      return postCount
    },
  }

  return provider
}

function viewOf(vps: MockVps): ProviderServerView {
  return {
    providerServerId: vps.id,
    state: vps.state === 'stopped' ? 'suspended' : 'active',
    hostname: vps.name,
    ipv4: vps.ipv4,
    ipv6: vps.ipv6,
    vcpu: vps.product.vcpu,
    memoryMb: vps.product.memoryMb,
    diskGb: vps.product.diskGb,
    trafficUsedGb: 0,
    metadata: { mock: true },
  }
}