import { hkdfSync, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as config from '../../src/config.js'
import * as policy from '../../src/modules/outbound/policy.js'
import { emptyOutboundState, OutboundHttp, selectedRoute, OutboundFailure } from '../../src/modules/outbound/client.js'
import { canManageOutbound, profileInput, routeInput, testInput, readOutbound, outboundKey } from '../../src/modules/outbound/settings.js'
import { seal } from '../../src/modules/system/security.js'
import type { DbClient } from '../../src/db/index.js'
import { safeMetadata } from '../../src/modules/system/events.js'
import type { OutboundState, OutboundIntegration } from '../../src/contracts/outbound.js'
import type { SessionUser } from '../../src/modules/auth/service.js'

const id = randomUUID(), adminId = randomUUID()
let state: OutboundState, clients: OutboundHttp[]
const url = 'https://api.hetzner.cloud/v1/locations'
function client() { const c = new OutboundHttp(async () => structuredClone(state)); clients.push(c); return c }
beforeEach(() => {
  clients = []
  state = { revision: randomUUID(), profiles: [{ id, name: 'Fixture', type: 'http', host: 'proxy.fixture.test', port: 8080, enabled: true, timeoutMs: 1000, username: 'fixture-user', password: 'fixture-password' }],
    routes: { hetzner: { enabled: true, profileId: id, failurePolicy: 'closed' } } }
  vi.spyOn(policy, 'publicAddresses').mockResolvedValue([{ address: '203.0.113.8', family: 4 }])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ locations: [] })))
})
afterEach(async () => { await Promise.all(clients.map(c => c.close())); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('outbound routing and safety', () => {
  it('defaults every integration to direct and never uses an unassigned proxy', () => {
    for (const integration of ['hetzner', 'leaseweb', 'parsgreen', 'tabapay', 'abantether'] as const) {
      expect(selectedRoute(emptyOutboundState(), integration)).toEqual({ route: 'direct', profileId: null })
    }
    expect(selectedRoute(state, 'parsgreen').route).toBe('direct')
  })
  it('refreshes API and worker snapshots and invalidates pools after edits or explicit route disable', async () => {
    const api = client(), worker = client()
    const first = await api.request('hetzner', url)
    const oldDispatcher = vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit & { dispatcher: { close(): Promise<void> } }
    const closed = vi.spyOn(oldDispatcher.dispatcher, 'close')
    expect(first.report.route).toBe('proxy')
    expect((await worker.request('hetzner', url)).report.route).toBe('proxy')
    state.revision = randomUUID(); state.profiles[0]!.password = 'rotated-fixture'
    await api.request('hetzner', url)
    expect(closed).toHaveBeenCalled()
    expect((vi.mocked(fetch).mock.calls.at(-1)![1] as typeof oldDispatcher).dispatcher).not.toBe(oldDispatcher.dispatcher)
    state.revision = randomUUID(); state.routes.hetzner!.enabled = false
    expect((await api.request('hetzner', url)).report.route).toBe('direct')
    expect((await worker.request('hetzner', url)).report.route).toBe('direct')
  })
  it('forces AbanTether direct despite saved proxies, environment proxies or unreadable proxy settings', async () => {
    state.routes.abantether = { enabled: true, profileId: id, failurePolicy: 'closed' }
    expect(selectedRoute(state, 'abantether')).toEqual({ route: 'direct', profileId: null })
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.fixture.test:8080')
    const read = vi.fn(async () => { throw new Error('unreadable proxy settings') })
    const c = new OutboundHttp(read); clients.push(c)
    try {
      expect((await c.request('abantether', policy.testTargets.abantether.url)).report).toEqual({ route: 'direct', profileId: null })
      expect(read).not.toHaveBeenCalled()
      expect(policy.publicAddresses).not.toHaveBeenCalled()
      const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit & { dispatcher?: unknown }
      expect(init.dispatcher).toBeTruthy()
      expect(init.redirect).toBe('error')
      await expect(c.request('abantether', policy.testTargets.abantether.url, {}, id)).rejects.toMatchObject({ category: 'policy' })
      expect(fetch).toHaveBeenCalledOnce()
      expect(routeInput.safeParse({ revision: state.revision, integration: 'abantether', ...state.routes.abantether, confirm: true }).success).toBe(false)
      expect(testInput.safeParse({ revision: state.revision, integration: 'abantether', profileId: id, confirm: true }).success).toBe(false)
    } finally { vi.unstubAllEnvs() }
  })
  it('blocks a required route whose profile is disabled instead of leaking direct traffic', async () => {
    state.profiles[0]!.enabled = false
    await expect(client().request('hetzner', url)).rejects.toMatchObject({ category: 'configuration', route: { route: 'blocked' } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['POST', 'DELETE', 'PATCH', 'PUT'])('never falls back or retries a %s with an ambiguous network outcome', async method => {
    state.routes.hetzner!.failurePolicy = 'read-only-direct'
    vi.mocked(fetch).mockRejectedValue(new Error('contains fixture-password and fixture-user'))
    const result = client().request('hetzner', url, { method, body: '{}' })
    await expect(result).rejects.toBeInstanceOf(OutboundFailure)
    await expect(result).rejects.toThrow('Outbound connection failed (unreachable)')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('fails closed by default for reads and only falls back on an explicitly allowed read', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('proxy unreachable'))
    await expect(client().request('hetzner', url)).rejects.toBeInstanceOf(OutboundFailure)
    expect(fetch).toHaveBeenCalledOnce()
    vi.mocked(fetch).mockReset().mockRejectedValueOnce(new Error('proxy unreachable')).mockResolvedValue(Response.json({ locations: [] }))
    state.routes.leaseweb = { enabled: true, profileId: id, failurePolicy: 'read-only-direct' }
    expect((await client().request('leaseweb', policy.testTargets.leaseweb.url)).report.route).toBe('direct-fallback')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('blocks direct fallback for Hetzner reads even with a legacy saved fallback policy', async () => {
    state.routes.hetzner!.failurePolicy = 'read-only-direct'
    vi.mocked(fetch).mockRejectedValue(new Error('proxy unavailable'))
    await expect(client().request('hetzner', url)).rejects.toMatchObject({ category: 'unreachable', route: { route: 'proxy' } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(routeInput.safeParse({ revision: state.revision, integration: 'hetzner', ...state.routes.hetzner, confirm: true }).success).toBe(false)
  })
  it('does not bypass policy errors or retry upstream errors, and refuses redirects', async () => {
    state.routes.hetzner!.failurePolicy = 'read-only-direct'
    vi.mocked(policy.publicAddresses).mockRejectedValue(new policy.OutboundError('policy'))
    await expect(client().request('hetzner', url)).rejects.toMatchObject({ category: 'policy' })
    expect(fetch).not.toHaveBeenCalled()
    vi.mocked(policy.publicAddresses).mockResolvedValue([{ address: '203.0.113.8', family: 4 }])
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }))
    expect((await client().request('hetzner', url, { redirect: 'follow' })).response.status).toBe(503)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls[0]![1]?.redirect).toBe('error')
  })
  it('does not route with missing or unreadable configuration', async () => {
    const c = new OutboundHttp(async () => { throw new Error('secret database value') }); clients.push(c)
    await expect(c.request('hetzner', url)).rejects.toMatchObject({ category: 'configuration', route: { route: 'blocked' } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('bounds a stalled proxy DNS lookup without dispatch or fallback', async () => {
    vi.mocked(policy.publicAddresses).mockImplementation(() => new Promise(() => undefined))
    await expect(client().request('hetzner', url, { signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ category: 'timeout' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('outbound security boundary', () => {
  it.each(['http://api.hetzner.cloud/v1', 'https://api.hetzner.cloud.evil.test/', 'https://api.hetzner.cloud:444/',
    'https://secret@api.hetzner.cloud/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/',
    'https://cloud-platform-api/', 'https://api.leaseweb.com/', 'https://api.hetzner.cloud/#redirect'])('refuses unapproved destination %s', async input => {
    await expect(client().request('hetzner', input)).rejects.toMatchObject({ category: 'policy' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.100.100.200', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3'])('rejects special address %s', address => {
    expect(policy.publicAddress(address)).toBe(false)
  })
  it('binds every integration to its own fixed HTTPS authority', () => {
    for (const [id, target] of Object.entries(policy.testTargets)) expect(policy.approvedTarget(id as OutboundIntegration, target.url).protocol).toBe('https:')
    expect(policy.publicAddress('8.8.8.8')).toBe(true)
  })
  it('rejects arbitrary diagnostic destinations and credential-bearing proxy host strings', () => {
    expect(testInput.safeParse({ revision: 'initial', integration: 'hetzner', url: 'http://localhost', confirm: true }).success).toBe(false)
    expect(profileInput.safeParse({ revision: 'initial', name: 'x', type: 'http', host: 'user:pass@example.test', port: 80, timeoutMs: 1000, confirm: true }).success).toBe(false)
    expect(routeInput.safeParse({ revision: 'initial', integration: 'internal', enabled: true, profileId: id, failurePolicy: 'closed', confirm: true }).success).toBe(false)
  })
  it('uses existing active admin roles without a separate ID list and keeps logs sanitized', () => {
    const user = { id: adminId, role: 'super_admin', status: 'active' } as SessionUser
    expect(canManageOutbound(user)).toBe(true)
    expect(canManageOutbound({ ...user, id: randomUUID() })).toBe(true)
    expect(canManageOutbound({ ...user, role: 'user' })).toBe(false)
    expect(canManageOutbound({ ...user, status: 'disabled' })).toBe(false)
    expect(safeMetadata({ integration: 'hetzner', route: 'proxy', profileId: id, password: 'fixture-password', username: 'fixture-user', url: 'https://secret@example.test' }))
      .toEqual({ integration: 'hetzner', route: 'proxy', profileId: id })
  })
  it('decrypts with the existing app secret without a separate store key and rejects a wrong key', async () => {
    const cfg = config.loadConfig({ NODE_ENV: 'test', AUTH_SECRET: 'fixture-existing-app-secret', STORE_SECRET_KEY: '' })
    vi.spyOn(config, 'getConfig').mockReturnValue(cfg)
    const key = Buffer.from(hkdfSync('sha256', cfg.AUTH_SECRET, 'parserver-outbound-v1', 'proxy-settings', 32))
    const encrypted = seal(Buffer.from(JSON.stringify(state)), `${outboundKey}:${state.revision}`, key).toString('base64')
    const db = { query: { settings: { findFirst: async () => ({ value: { revision: state.revision, encrypted } }) } } } as unknown as DbClient
    expect(encrypted).not.toContain('fixture-password')
    expect(await readOutbound(db)).toEqual(state)
    cfg.AUTH_SECRET = 'fixture-wrong-app-secret'
    await expect(readOutbound(db)).rejects.toMatchObject({ category: 'configuration' })
  })
})
