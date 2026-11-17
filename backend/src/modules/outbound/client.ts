import type { Dispatcher } from 'undici'
import type { NetworkCategory, OutboundIntegration, OutboundState, ProxyProfile, RouteReport } from '../../contracts/outbound.js'
import { approvedHetznerConsole, approvedTarget, errorCategory, OutboundError, publicAddresses, withinDeadline } from './policy.js'
import { connectTargetTls, directDispatcher, proxyDispatcher } from './transport.js'
import { recordEvent } from '../system/events.js'

export const emptyOutboundState = (): OutboundState => ({ revision: 'initial', profiles: [], routes: {} })
export class OutboundFailure extends OutboundError {
  constructor(error: unknown, readonly route: RouteReport) { super(errorCategory(error)) }
}
export function selectedRoute(state: OutboundState, integration: OutboundIntegration): RouteReport {
  if (integration === 'abantether') return { route: 'direct', profileId: null }
  const route = state.routes[integration]
  if (!route?.enabled) return { route: 'direct', profileId: null }
  if (!route.profileId) return { route: 'blocked', profileId: null }
  return { route: state.profiles.some(p => p.id === route.profileId && p.enabled) ? 'proxy' : 'blocked', profileId: route.profileId }
}

/** One instance per process, one DB snapshot per request; no stale worker cache. */
export class OutboundHttp {
  private revision = ''
  private pools = new Map<string, Dispatcher>()
  constructor(private readonly read: () => Promise<OutboundState>) {}
  private retirePools() {
    for (const pool of this.pools.values()) void pool.close().catch(() => undefined)
    this.pools.clear()
  }
  async close() { const pools = [...this.pools.values()]; this.pools.clear(); await Promise.all(pools.map(pool => pool.close())) }

  private async route(integration: OutboundIntegration, deadline: AbortSignal, testProfile?: string) {
    // Domestic rate source is direct-only, including legacy routes and diagnostics.
    // Do not depend on encrypted proxy settings being readable to fetch FX.
    if (integration === 'abantether') {
      if (testProfile) throw new OutboundFailure(new OutboundError('policy'), { route: 'blocked', profileId: null })
      return { state: { ...emptyOutboundState(), revision: this.revision || 'initial' }, report: selectedRoute(emptyOutboundState(), integration), profile: undefined }
    }
    let state: OutboundState
    try { state = await withinDeadline(this.read(), deadline) } catch (error) {
      const failure = deadline.aborted ? new OutboundError('timeout') : new OutboundError('configuration')
      throw new OutboundFailure(error instanceof OutboundError ? error : failure, { route: 'blocked', profileId: null })
    }
    const report = testProfile ? { route: 'proxy' as const, profileId: testProfile } : selectedRoute(state, integration)
    return { state, report, profile: state.profiles.find(p => p.id === report.profileId) }
  }

  async openHetznerConsole(input: string, cancel: AbortSignal) {
    const url = approvedHetznerConsole(input)
    const deadline = AbortSignal.any([cancel, AbortSignal.timeout(10000)])
    const started = Date.now()
    let report: RouteReport = { route: 'blocked', profileId: null }
    let revision = 'unknown'
    const record = (code: NetworkCategory, elapsedMs: number) => recordEvent('outbound.console', code === 'none' ? 'info' : 'warn', 'outbound', {
      integration: 'hetzner', route: report.route, profileId: report.profileId, revision, code, elapsedMs,
    })
    try {
      const route = await this.route('hetzner', deadline)
      report = route.report; revision = route.state.revision
      if (report.route === 'blocked') throw new OutboundError('configuration')
      const profile = route.profile
      const signal = profile ? AbortSignal.any([deadline, AbortSignal.timeout(profile.timeoutMs)]) : deadline
      const via = profile && { profile, address: (await withinDeadline(publicAddresses(profile.host), signal))[0]!.address }
      const socket = await connectTargetTls(url.hostname, signal, via)
      return { url, socket, signal, record, started,
        isCurrent: async () => (await this.route('hetzner', AbortSignal.any([cancel, AbortSignal.timeout(5000)]))).state.revision === revision }
    } catch (error) {
      const failure = new OutboundFailure(error, report)
      if (!cancel.aborted) record(failure.category, Date.now() - started)
      throw failure
    }
  }

  async request(integration: OutboundIntegration, input: string | URL, init: RequestInit = {}, testProfile?: string) {
    const url = approvedTarget(integration, input)
    const started = Date.now()
    const deadline = AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])])
    const { state, report, profile } = await this.route(integration, deadline, testProfile)
    if (state.revision !== this.revision) { this.retirePools(); this.revision = state.revision }
    if (report.route === 'blocked' || testProfile && !profile) throw new OutboundFailure(new OutboundError('configuration'), report)
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(profile?.timeoutMs ?? 30000)])
    const event = (route: RouteReport, category: string, httpStatus?: number) => recordEvent('outbound.request', category === 'none' ? 'info' : 'warn', 'outbound', {
      integration, route: route.route, profileId: route.profileId, code: category, httpStatus, elapsedMs: Date.now() - started,
    })
    const dispatch = async (via?: ProxyProfile) => {
      const address = via ? (await withinDeadline(publicAddresses(via.host), signal))[0]!.address : ''
      signal.throwIfAborted()
      const key = `${state.revision}:${via?.id ?? 'direct'}:${address}`
      let dispatcher = this.pools.get(key)
      if (!dispatcher) {
        dispatcher = via ? proxyDispatcher(via, address) : directDispatcher()
        // A slow old DNS lookup must not repopulate a newer revision's cache.
        if (state.revision === this.revision) this.pools.set(key, dispatcher)
        else void signal.addEventListener('abort', () => void dispatcher!.close().catch(() => undefined), { once: true })
      }
      return fetch(url.href, { ...init, redirect: 'error', signal, dispatcher } as RequestInit)
    }
    try {
      const response = await dispatch(report.route === 'proxy' ? profile : undefined)
      event(report, 'none', response.status)
      return { response, report, revision: state.revision }
    } catch (error) {
      // Never redispatch a mutation. Read fallback is explicit and uses the same total deadline.
      const safeRead = ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())
      if (integration !== 'hetzner' && !testProfile && report.route === 'proxy' && safeRead && state.routes[integration]?.failurePolicy === 'read-only-direct'
          && errorCategory(error) !== 'policy' && !signal.aborted) {
        const fallback = { route: 'direct-fallback' as const, profileId: profile!.id }
        try { const response = await dispatch(); event(fallback, 'none', response.status); return { response, report: fallback, revision: state.revision } }
        catch (failure) { event(fallback, errorCategory(failure)); throw new OutboundFailure(failure, fallback) }
      }
      event(report, errorCategory(error))
      throw new OutboundFailure(error, report)
    }
  }
}

let active: OutboundHttp | undefined
export function installOutboundClient(client: OutboundHttp) {
  active = client
  return async () => { if (active === client) active = undefined; await client.close() }
}
const unconfigured = new OutboundHttp(async () => {
  // Production entrypoints must install a policy reader, including CLI scripts.
  if (process.env.NODE_ENV !== 'test') throw new OutboundError('configuration')
  return emptyOutboundState()
})
export const outboundFetch = async (integration: OutboundIntegration, input: string | URL, init?: RequestInit) =>
  (await (active ?? unconfigured).request(integration, input, init)).response
export const openHetznerConsole = (input: string, signal: AbortSignal) => (active ?? unconfigured).openHetznerConsole(input, signal)
export const integrationFetcher = (integration: OutboundIntegration): typeof fetch => (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) throw new OutboundError('policy')
  return outboundFetch(integration, input, init)
}
