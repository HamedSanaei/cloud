import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { Socket } from 'node:net'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { getConfig, type HetznerConfig } from '../../src/config.js'
import { buildApp } from '../../src/app.js'
import { createHetznerProvider } from '../../src/modules/providers/hetzner/live.js'
import { registerProvider } from '../../src/modules/providers/registry.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { creditWallet, ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { handleProvision, handleReconcile, handleRenewalSweep, handleServerAction, handleServerSync } from '../../src/modules/provisioning/handlers.js'
import { idempotencyKeys, providerOperations, servers, settings, subscriptions, users, wallets } from '../../src/db/schema.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'
import type { ManagementAction } from '../../src/modules/providers/customer.interface.js'

const { openSocket } = vi.hoisted(() => ({ openSocket: vi.fn() }))
vi.mock('../../src/modules/servers/console-transport.js', () => ({ connectConsole: openSocket }))

type Json = Record<string, unknown>
const config: HetznerConfig = { enabled: true, orderingEnabled: true, displayName: 'Fixture', baseUrl: 'https://provider.test/v1', accounts: [
  { id: 'owning-project', label: 'Fixture owner', priority: 1, enabled: true, state: 'active', apiToken: 'fixture-project-secret' },
  { id: 'other-project', label: 'Fixture other', priority: 2, enabled: false, state: 'disabled', apiToken: 'fixture-other-secret' },
] }
describe.skipIf(!dbAvailable)('customer-owned Hetzner lifecycle and billing safety', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>, app: FastifyInstance, sequence = 100
  const machines = new Map<number, Json>(), actions = new Map<number, Json>(), calls: Array<{ method: string; path: string; account: string }> = []
  let loseDeleteResponse = false
  const primaryIps = new Map<number, Json>()
  let ipSequence = 10000, rejectNextAssignment: number | null = null, loseNextIpCreate: 'before' | 'after' | null = null
  const type = { id: 1, name: 'cx-fixture', architecture: 'x86', storage_type: 'local', cores: 2, memory: 4, disk: 40,
    locations: [{ name: 'hel1', available: true }], prices: [{ location: 'hel1', price_hourly: { gross: '0.0044' }, price_monthly: { gross: '3.79' } }] }
  const largerType = { ...type, id: 2, name: 'cx-fixture-large', cores: 4, memory: 8, disk: 80, prices: [{ location: 'hel1', price_hourly: { gross: '0.0088' }, price_monthly: { gross: '7.58' } }] }
  const fetcher: typeof fetch = async (url, init) => {
    const request = new URL(String(url)); expect(request.origin).toBe('https://provider.test')
    const path = request.pathname.replace('/v1', ''), method = init?.method ?? 'GET', account = new Headers(init?.headers).get('authorization') ?? ''
    calls.push({ method, path, account })
    const json = (data: unknown) => Response.json(data)
    const missing = () => Response.json({ error: { code: 'not_found' } }, { status: 404 })
    const receipt = (command: string, type: 'server' | 'primary_ip', id: number) => {
      const action = { id: 1000 + calls.length, command, status: 'success', resources: [{ id, type }] }
      actions.set(action.id, action)
      return action
    }
    if (/^\/(servers|primary_ips)\/actions\/\d+$/.test(path)) return json({ action: actions.get(Number(path.split('/').at(-1))) })
    if (path === '/primary_ips' && method === 'POST') {
      if (loseNextIpCreate === 'before') { loseNextIpCreate = null; throw new Error('fixture lost request before creation') }
      const body = JSON.parse(String(init?.body)), id = ++ipSequence
      expect(body).toMatchObject({ type: 'ipv4', location: 'hel1', auto_delete: true })
      const ip = { id, ip: `198.51.100.${id - 10000}`, type: 'ipv4', location: { name: body.location }, labels: body.labels,
        assignee_id: null, assignee_type: 'unassigned', auto_delete: true, blocked: false, protection: { delete: false } }
      primaryIps.set(id, ip)
      if (loseNextIpCreate === 'after') { loseNextIpCreate = null; throw new Error('fixture lost create receipt') }
      return json({ primary_ip: ip, action: null })
    }
    if (path === '/primary_ips') {
      const label = request.searchParams.get('label_selector')?.split('=')[1]
      return json({ primary_ips: [...primaryIps.values()].filter(ip => (ip.labels as Json)?.['parserver-ip-operation'] === label) })
    }
    const ipPath = path.match(/^\/primary_ips\/(\d+)(?:\/actions\/(assign|unassign))?$/)
    if (ipPath) {
      const id = Number(ipPath[1]), ip = primaryIps.get(id), command = ipPath[2]
      if (!ip) return missing()
      if (method === 'GET') return json({ primary_ip: ip })
      if (method === 'DELETE') {
        expect(ip.assignee_id).toBeNull()
        primaryIps.delete(id)
        return new Response(null, { status: 204 })
      }
      const serverId = command === 'assign' ? JSON.parse(String(init?.body)).assignee_id : Number(ip.assignee_id)
      if (command === 'assign' && rejectNextAssignment === serverId) {
        rejectNextAssignment = null
        return Response.json({ error: { code: 'invalid_input' } }, { status: 422 })
      }
      const machine = machines.get(serverId)!
      expect(machine.status).toBe('off')
      ip.assignee_id = command === 'assign' ? serverId : null
      ip.assignee_type = command === 'assign' ? 'server' : 'unassigned'
      ;(machine.public_net as Json).ipv4 = command === 'assign' ? { id, ip: ip.ip } : null
      return json({ action: receipt(`${command}_primary_ip`, 'primary_ip', id) })
    }
    if (path === '/server_types') return json({ server_types: [type, largerType] })
    if (path === '/locations') return json({ locations: [{ name: 'hel1', country: 'FI', city: 'Helsinki' }] })
    if (path === '/pricing') return json({ pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [{ location: 'hel1', price_hourly: { gross: '0.0008' } }] }] } })
    if (path === '/images') return json({ images: [{ id: 11, name: 'ubuntu-24.04', architecture: 'x86', type: 'system', status: 'available' }] })
    if (/^\/servers\/\d+\/metrics$/.test(path)) return json({ metrics: { time_series: { cpu: { values: [[100, '15'], [160, null], [220, 'NaN'], [280, '0']] }, 'network.0.bandwidth.in': { values: [[100, '42']] } } } })
    if (method === 'GET' && /^\/servers\/\d+\/actions$/.test(path)) {
      const id = Number(path.split('/')[2]), actionId = request.searchParams.get('id')
      const found = [...actions.values()].filter(action => (actionId === null || String(action.id) === actionId) &&
        (action.resources as Array<{ id: number }> | undefined)?.some(resource => resource.id === id))
      return json({ actions: found, meta: { pagination: { page: 1, per_page: 50, next_page: null, total_entries: found.length } } })
    }
    if (method === 'POST' && path === '/servers') {
      const body = JSON.parse(String(init?.body)), id = ++sequence
      const machine = { id, name: body.name, status: 'initializing', created: new Date().toISOString(), server_type: type, primary_disk_size: 40,
        location: { name: 'hel1' }, image: { id: 11, name: 'ubuntu-24.04' }, outgoing_traffic: 250000000, included_traffic: 20000000000000,
        public_net: { ipv4: { ip: '192.0.2.10' }, ipv6: { ip: '2001:db8::/64' } }, protection: { delete: false, rebuild: false }, user_data: 'fixture-private-user-data' }
      machines.set(id, machine); return json({ server: machine, action: { id: 9, status: 'running' } })
    }
    const match = path.match(/^\/servers\/(\d+)(?:\/actions\/([^/]+))?$/), id = Number(match?.[1]), command = match?.[2]
    if (method === 'GET' && command && /^\d+$/.test(command)) return json({ action: actions.get(Number(command)) })
    if (!machines.has(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    if (method === 'GET') return json({ server: machines.get(id) })
    if (['shutdown', 'poweron'].includes(command ?? '') && (machines.get(id)!.public_net as Json).ipFixture === true) {
      machines.get(id)!.status = command === 'shutdown' ? 'off' : 'running'
      return json({ action: receipt(command === 'shutdown' ? 'shutdown_server' : 'start_server', 'server', id) })
    }
    if (command === 'request_console') return json({ action: { id: 8, status: 'success' }, wss_url: 'wss://console.hetzner.cloud/fixture?ticket=fixture-ticket', password: 'fixture-console-password' })
    const actionId = 1000 + calls.length
    actions.set(actionId, { id: actionId, status: 'running', command: method === 'DELETE' ? 'delete_server' : command === 'poweroff' ? 'stop_server' : command })
    if (method === 'DELETE' && loseDeleteResponse) { machines.delete(id); throw new Error('fixture lost response') }
    return json({ action: actions.get(actionId), ...(['reset_password', 'rebuild', 'enable_rescue'].includes(command ?? '') ? { root_password: 'Fixture-sensitive-root-password!' } : {}) })
  }
  beforeAll(async () => {
    ctx = await getTestContext(); await truncateAll(ctx.db); await setFxRate(ctx.db, '620000')
    const provider = createHetznerProvider(config, { fetch: fetcher }); registerProvider(provider)
    await syncProviderCatalog(ctx.db, provider, { mode: 'live' }); await enableAllOffersForSale(ctx.db, 'hetzner')
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger }); await app.ready()
  })
  afterAll(async () => { await app?.close(); await ctx?.close() })
  async function buy() {
    const user = await registerUser(ctx.db, { email: `customer-${randomUUID()}@fixture.test`, password: 'Fixture-customer-123!' }), session = await createSession(ctx.db, user.id, {})
    const headers = { authorization: `Bearer ${session.token}` }, wallet = await ensureDefaultWallet(ctx.db, user.id)
    await creditWallet(ctx.db, user.id, wallet.id, 100000000, { idempotencyKey: randomUUID() })
    const offer = await findOfferByProductAndLocation(ctx.db, 'hetzner', 'cx-fixture:EUR', 'hel1')
    const response = await app.inject({ method: 'POST', url: '/api/servers', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { name: 'fixture-server', offerId: offer!.id, os: '11', walletId: wallet.id, billingPeriod: 'hourly' } })
    expect(response.statusCode, response.body).toBe(201)
    const initial = response.json().data, orderId = initial.tracking.orderId as string
    await handleProvision(ctx, { orderId })
    const server = (await ctx.db.query.servers.findFirst({ where: t => eq(t.orderId, orderId) }))!, providerId = Number(server.providerServerId!.split(':')[1])
    return { user, session, headers, wallet, initial, orderId, server, providerId, remoteAddress: `192.0.2.${providerId - 100}` }
  }
  type Purchase = Awaited<ReturnType<typeof buy>>
  async function activate(p: Purchase) { machines.get(p.providerId)!.status = 'running'; await handleServerSync(ctx, { serverId: p.server.id }) }
  async function action(p: Purchase, command: ManagementAction, key = randomUUID()) {
    const response = await app.inject({ method: 'POST', remoteAddress: p.remoteAddress, url: `/api/servers/${p.server.id}/management/actions`, headers: { ...p.headers, 'idempotency-key': key }, payload: { action: command, hostname: 'fixture-server', confirm: true } })
    expect(response.statusCode, response.body).toBe(202); return response.json().data.id as string
  }
  async function ipServer() {
    const p = await buy(), id = ++ipSequence
    primaryIps.set(id, { id, ip: '192.0.2.10', type: 'ipv4', location: { name: 'hel1' }, labels: {}, assignee_id: p.providerId,
      assignee_type: 'server', auto_delete: true, blocked: false, protection: { delete: false } })
    const network = machines.get(p.providerId)!.public_net as Json
    network.ipv4 = { id, ip: '192.0.2.10' }
    network.ipFixture = true
    await activate(p)
    return { ...p, oldIpId: id }
  }
  async function ipQuote(p: Purchase) {
    return (await app.inject({ url: `/api/servers/${p.server.id}/management`, remoteAddress: p.remoteAddress, headers: p.headers })).json().data.primaryIpv4
  }
  function requestIp(p: Purchase, quote: { currentIp: string; feeRial: number; version: string }, key = randomUUID()) {
    return app.inject({ method: 'POST', remoteAddress: p.remoteAddress, url: `/api/servers/${p.server.id}/primary-ipv4`,
      headers: { ...p.headers, 'idempotency-key': key }, payload: { currentIp: quote.currentIp, feeRial: quote.feeRial, version: quote.version, hostname: 'fixture-server', confirm: true } })
  }
  async function driveIp(p: Purchase, operationId: string, target: string) {
    for (let step = 0; step < 12; step++) {
      await Promise.all([handleServerSync(ctx, { serverId: p.server.id }), handleServerSync(ctx, { serverId: p.server.id })])
      const operation = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, operationId) }))!
      if (operation.status === target) return operation
    }
    throw new Error(`Primary IPv4 operation never reached ${target}`)
  }
  const ipLedger = (p: Purchase) => ctx.db.query.walletTransactions.findMany({ where: (t, { and }) => and(eq(t.walletId, p.wallet.id), eq(t.referenceType, 'primary_ipv4_replacement')) })

  it('locks a verified server, accepts concurrent retries once, and settles the accepted fee after provider confirmation', async () => {
    const p = await ipServer(), quote = await ipQuote(p), key = randomUUID()
    expect(quote).toMatchObject({ currentIp: '192.0.2.10', feeRial: 1500000, reason: null })
    const responses = await Promise.all([requestIp(p, quote, key), requestIp(p, quote, key)])
    expect(responses.map(response => response.statusCode)).toEqual([202, 202])
    const id = responses[0].json().data.id
    expect(responses[1].json().data.id).toBe(id)
    expect((await requestIp(p, quote)).statusCode).toBe(409)
    const blocked = await app.inject({ method: 'POST', remoteAddress: p.remoteAddress, url: `/api/servers/${p.server.id}/management/actions`,
      headers: { ...p.headers, 'idempotency-key': randomUUID() }, payload: { hostname: 'fixture-server', action: 'delete', confirm: true } })
    expect(blocked.statusCode).toBe(409)
    const admin = await registerUser(ctx.db, { email: 'ip-super-admin@fixture.test', password: 'Fixture-admin-123!' })
    await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    const session = await createSession(ctx.db, admin.id, {}), headers = { authorization: `Bearer ${session.token}` }
    const pricing = '/api/admin/settings/primary-ipv4-pricing/hetzner'
    expect((await app.inject({ method: 'POST', url: pricing, headers, payload: { confirm: true, feeRial: 2000000 } })).statusCode).toBe(403)
    const allowlist = getConfig().PRIMARY_IPV4_SUPER_ADMIN_IDS
    allowlist.push(admin.id)
    try {
      expect((await app.inject({ method: 'POST', url: pricing, headers, payload: { confirm: true, feeRial: 0 } })).statusCode).toBe(422)
      expect((await app.inject({ method: 'POST', url: pricing, headers, payload: { confirm: true, feeRial: 2000000 } })).statusCode).toBe(200)
      const result = (await app.inject({ url: pricing, headers })).json().data
      expect(result).toMatchObject({ feeRial: 2000000, history: [{ actorId: admin.id, metadata: { previousRial: 1500000, feeRial: 2000000 } }] })
      const before = calls.length
      const operation = await driveIp(p, id, 'succeeded')
      const updates = calls.slice(before).filter(call => call.method !== 'GET')
      expect(updates.every(call => call.account === 'Bearer fixture-project-secret')).toBe(true)
      expect(updates.map(call => call.path)).toEqual([`/servers/${p.providerId}/actions/shutdown`, '/primary_ips',
        `/primary_ips/${p.oldIpId}/actions/unassign`, expect.stringMatching(/\/primary_ips\/\d+\/actions\/assign/),
        `/servers/${p.providerId}/actions/poweron`, `/primary_ips/${p.oldIpId}`])
      expect(await ipLedger(p)).toEqual([expect.objectContaining({ amountRial: -1500000, referenceId: p.server.id, description: 'تعویض IPv4 اصلی — fixture-server' })])
      const listed = (await app.inject({ url: '/api/servers', headers: p.headers })).json().data
      expect(listed.find((s: { id: string }) => s.id === p.server.id).ip).toBe((operation.responseMetadata as Json).newIp)
      expect((await requestIp(p, quote, key)).json().data.id).toBe(id)
      expect((await requestIp(p, { ...quote, currentIp: (operation.responseMetadata as Json).newIp as string })).statusCode).toBe(409)
    } finally {
      allowlist.pop()
      await ctx.db.delete(settings).where(eq(settings.key, 'primary_ipv4.fee.hetzner'))
    }
  })

  it('rejects other owners and unsupported providers, and never dispatches with insufficient funds', async () => {
    const p = await ipServer(), quote = await ipQuote(p), other = await buy()
    const writes = calls.filter(call => call.method !== 'GET').length
    expect((await requestIp({ ...p, headers: other.headers }, quote)).statusCode).toBe(404)
    await ctx.db.update(wallets).set({ balanceRial: 0 }).where(eq(wallets.id, p.wallet.id))
    expect((await ipQuote(p)).needsTopUp).toBe(true)
    const insufficient = await requestIp(p, quote)
    expect(insufficient.statusCode).toBe(422)
    expect(insufficient.json().error).toBe('insufficient_funds')
    await ctx.db.update(servers).set({ provider: 'asiatech' }).where(eq(servers.id, p.server.id))
    try {
      expect((await ipQuote(p)).reason).toContain('پشتیبانی')
      expect((await requestIp(p, quote)).statusCode).toBe(409)
      expect(await ipLedger(p)).toEqual([])
      expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
    } finally {
      await ctx.db.update(servers).set({ provider: 'hetzner' }).where(eq(servers.id, p.server.id))
    }
  })

  it('reattaches the original IP, restores power, cleans up and refunds once on rejected attachment', async () => {
    const p = await ipServer(), quote = await ipQuote(p)
    rejectNextAssignment = p.providerId
    const accepted = await requestIp(p, quote), id = accepted.json().data.id
    expect(accepted.statusCode).toBe(202)
    const operation = await driveIp(p, id, 'failed')
    expect(operation.responseMetadata).toMatchObject({ step: 'remove_new', refundId: expect.any(String) })
    expect(machines.get(p.providerId)).toMatchObject({ status: 'running', public_net: { ipv4: { id: p.oldIpId, ip: '192.0.2.10' } } })
    expect(primaryIps.has((operation.responseMetadata as Json).ipId as number)).toBe(false)
    expect((await ipLedger(p)).map(row => row.amountRial).sort()).toEqual([-1500000, 1500000])
  })

  it('recovers a lost create receipt by its exact project label without another purchase or retaining the fee', async () => {
    const p = await ipServer(), quote = await ipQuote(p)
    loseNextIpCreate = 'after'
    const accepted = await requestIp(p, quote), id = accepted.json().data.id
    expect(accepted.statusCode).toBe(202)
    const before = calls.length
    await driveIp(p, id, 'needs_reconciliation')
    expect((await ipLedger(p)).map(row => row.amountRial).sort()).toEqual([-1500000, 1500000])
    const operation = await driveIp(p, id, 'succeeded')
    expect(operation.responseMetadata).toMatchObject({ refundId: expect.any(String), newIp: expect.any(String) })
    expect(calls.slice(before).filter(call => call.method === 'POST' && call.path === '/primary_ips')).toHaveLength(1)
    expect(await ipLedger(p)).toHaveLength(2)
  })

  it('lets only an authorized operator release an ambiguous operation after verifying original power and IP', async () => {
    const p = await ipServer(), quote = await ipQuote(p)
    loseNextIpCreate = 'before'
    const id = (await requestIp(p, quote)).json().data.id
    await driveIp(p, id, 'needs_reconciliation')
    const admin = await registerUser(ctx.db, { email: 'ip-operator@fixture.test', password: 'Fixture-admin-123!' })
    await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    const session = await createSession(ctx.db, admin.id, {})
    const submit = () => app.inject({ method: 'POST', url: `/api/admin/settings/primary-ipv4-operations/${id}/confirm-rollback`,
      headers: { authorization: `Bearer ${session.token}` }, payload: { note: 'Reviewed project history', confirm: true } })
    expect((await submit()).statusCode).toBe(403)
    const allowlist = getConfig().PRIMARY_IPV4_SUPER_ADMIN_IDS
    allowlist.push(admin.id)
    try {
      await ctx.db.update(providerOperations).set({ updatedAt: new Date(0) }).where(eq(providerOperations.id, id))
      expect((await submit()).statusCode).toBe(409)
      machines.get(p.providerId)!.status = 'running'
      expect((await submit()).statusCode).toBe(200)
      expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))?.status).toBe('failed')
      expect(await ipLedger(p)).toHaveLength(2)
      expect((await ipQuote(p)).reason).toBeNull()
    } finally { allowlist.pop() }
  })
  it('recovers one owned pending row and never labels an accepted create as ready', async () => {
    const p = await buy()
    const notices = async () => (await app.inject({ url: '/api/notifications', headers: p.headers })).json().data as Array<{ id: string; title: string; read: boolean; href: string }>
    expect((await notices()).filter(item => item.title === 'سرور شما آماده است')).toHaveLength(0)
    expect(p.initial).toMatchObject({ id: `order:${p.orderId}`, lifecycle: 'queued', tracking: { orderId: p.orderId, serverId: null, state: 'queued' } })
    expect(p.initial.ip).toBeUndefined(); expect(p.initial.cpu).toBe('')
    const pending = await app.inject({ url: `/api/servers/provisioning/${p.orderId}`, headers: p.headers })
    expect(pending.json().data.tracking).toMatchObject({ state: 'provisioning', serverId: p.server.id })
    await activate(p)
    const ready = await app.inject({ url: `/api/servers/provisioning/${p.orderId}`, headers: p.headers })
    expect(ready.json().data).toMatchObject({ id: p.server.id, tracking: { state: 'ready', orderId: p.orderId }, ip: '192.0.2.10', cpu: '2 vCPU' })
    await handleServerSync(ctx, { serverId: p.server.id })
    const completion = (await notices()).filter(item => item.title === 'سرور شما آماده است')
    expect(completion).toEqual([expect.objectContaining({ read: false, href: `/servers/${p.server.id}` })])
    const [notice] = completion
    const other = await registerUser(ctx.db, { email: `notification-${randomUUID()}@fixture.test`, password: 'Fixture-customer-123!' })
    const otherSession = await createSession(ctx.db, other.id, {})
    await app.inject({ method: 'PATCH', url: '/api/notifications/read', headers: { authorization: `Bearer ${otherSession.token}` }, payload: { ids: [notice!.id] } })
    expect((await notices()).find(item => item.id === notice!.id)?.read).toBe(false)
    const marked = await app.inject({ method: 'PATCH', url: '/api/notifications/read', headers: p.headers, payload: { ids: [notice!.id] } })
    expect(marked.statusCode).toBe(200)
    expect((await notices()).find(item => item.id === notice!.id)?.read).toBe(true)
  })
  it('fixes Power Off with fractional traffic, preserves Action ID and waits for the confirmed off state', async () => {
    const p = await buy(); await activate(p)
    const invalid = await app.inject({ method: 'POST', url: `/api/servers/${p.server.id}/actions/power-off`, headers: p.headers, payload: {} })
    expect(invalid.statusCode).toBe(422)
    const id = await action(p, 'power_off')
    await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'power_off' })
    let op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!
    expect(op.status).toBe('running'); expect(op.responseMetadata).toMatchObject({ accepted: true, actionId: expect.any(Number) })
    const actionId = (op.responseMetadata as { actionId: number }).actionId
    // A receipt written by the previous release only recorded the action ID.
    await ctx.db.update(providerOperations).set({ responseMetadata: { accepted: true, actionId } }).where(eq(providerOperations.id, id))
    machines.get(p.providerId)!.status = 'off'
    await handleServerSync(ctx, { serverId: p.server.id })
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!.status).toBe('running')
    expect(await ctx.db.query.notifications.findFirst({ where: t => eq(t.eventKey, `server-operation:${id}:succeeded`) })).toBeUndefined()
    await ctx.db.update(providerOperations).set({ createdAt: new Date(Date.now() - 180000) }).where(eq(providerOperations.id, id))
    await handleServerSync(ctx, { serverId: p.server.id })
    const delayed = await app.inject({ url: `/api/servers/${p.server.id}/management`, headers: p.headers })
    expect(delayed.json().data.operations[0].status).toBe('outcome_unknown')
    expect(delayed.json().data.accessEligibility).toEqual({ rebuild: 'operation_pending', resetPassword: 'operation_pending' })
    expect(await ctx.db.query.notifications.findFirst({ where: t => eq(t.eventKey, `server-operation:${id}:unknown`) })).toMatchObject({ type: 'warning' })
    actions.get(actionId)!.status = 'success'
    await Promise.all([handleServerSync(ctx, { serverId: p.server.id }), handleServerSync(ctx, { serverId: p.server.id })])
    const server = (await ctx.db.query.servers.findFirst({ where: t => eq(t.id, p.server.id) }))!
    expect(server.status).toBe('suspended'); expect(server.trafficUsedGb).toBe(0)
    expect(server.providerMetadata).toMatchObject({ outgoingTrafficBytes: 250000000 })
    op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!; expect(op.status).toBe('succeeded')
    await handleServerAction(ctx, { operationId: id, serverId: server.id, action: 'power_off' })
    expect(calls.filter(c => c.method === 'POST' && c.path === `/servers/${p.providerId}/actions/poweroff`)).toHaveLength(1)
    const final = await app.inject({ url: `/api/servers/${p.server.id}/management`, headers: p.headers })
    expect(final.json().data).toMatchObject({ providerState: 'suspended', power: { pendingAction: null }, operations: [expect.objectContaining({ status: 'confirmed' })] })
    expect(final.json().data.accessEligibility).toEqual({ rebuild: null, resetPassword: null })
    expect(await ctx.db.query.notifications.findMany({ where: t => eq(t.eventKey, `server-operation:${id}:succeeded`) })).toEqual([
      expect.objectContaining({ userId: p.user.id, title: 'سرور خاموش شد', href: `/servers/${p.server.id}?tab=operations` }),
    ])
  })
  it('rechecks live rebuild protection and reports provider access denial without queuing an action', async () => {
    const p = await buy(); await activate(p)
    const read = async (refresh = false) => {
      const response = await app.inject({ url: `/api/servers/${p.server.id}/management${refresh ? '?refresh=1' : ''}`,
        remoteAddress: p.remoteAddress, headers: p.headers })
      expect(response.statusCode).toBe(200)
      return response.json().data.accessEligibility
    }
    expect(await read()).toEqual({ rebuild: null, resetPassword: null })
    const machine = machines.get(p.providerId)!
    machine.protection = { delete: false, rebuild: true }
    expect(await read(true)).toEqual({ rebuild: 'rebuild_protected', resetPassword: null })
    machines.delete(p.providerId)
    expect(await read(true)).toEqual({ rebuild: 'provider_access_denied', resetPassword: 'provider_access_denied' })
    machines.set(p.providerId, machine)
    machine.protection = { delete: false, rebuild: false }
    expect(await read(true)).toEqual({ rebuild: null, resetPassword: null })
    expect(calls.filter(c => c.method === 'POST' && c.path.startsWith(`/servers/${p.providerId}/actions/`))).toEqual([])
  })
  it('reconciles a lost delete response, fences concurrent renewals and retains the paid ledger', async () => {
    const p = await buy(); await activate(p)
    const sub = (await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.serverId, p.server.id) }))!
    await ctx.db.update(subscriptions).set({ nextInvoiceAt: new Date(0), currentPeriodEnd: new Date(0) }).where(eq(subscriptions.id, sub.id))
    const before = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))!.balanceRial, key = randomUUID()
    const id = await action(p, 'delete', key); expect(await action(p, 'delete', key)).toBe(id)
    const fleet = await app.inject({ url: '/api/servers', headers: p.headers })
    expect(fleet.json().data.find((row: { id: string }) => row.id === p.server.id)).toMatchObject({ lifecycle: 'deletion_requested', power: { canPowerOn: false, canPowerOff: false } })
    await handleRenewalSweep(ctx)
    loseDeleteResponse = true
    await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'delete' })
    loseDeleteResponse = false
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!.status).toBe('unknown')
    await Promise.all([handleServerSync(ctx, { serverId: p.server.id }), handleRenewalSweep(ctx), handleRenewalSweep(ctx)])
    expect((await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, sub.id) }))!).toMatchObject({ status: 'cancelled', autoRenew: false })
    expect((await ctx.db.query.servers.findFirst({ where: t => eq(t.id, p.server.id) }))!).toMatchObject({ status: 'terminated', terminationState: 'terminated' })
    await handleRenewalSweep(ctx)
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))!.balanceRial).toBe(before)
    expect(calls.filter(c => c.method === 'DELETE' && c.path === `/servers/${p.providerId}`)).toHaveLength(1)
    expect((await ctx.db.query.invoices.findMany({ where: t => eq(t.orderId, p.orderId) })).filter(invoice => invoice.status === 'paid')).toHaveLength(1)
  })
  it('encrypts root output, binds it to the initiating session, and permits only one claim', async () => {
    const p = await buy(); await activate(p)
    const id = await action(p, 'reset_password'); await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'reset_password' })
    const secret = (await ctx.db.query.serverSecrets.findFirst({ where: t => eq(t.operationId, id) }))!
    expect(secret.encrypted).not.toContain('Fixture-sensitive-root-password!')
    const op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!, actionId = (op.responseMetadata as { actionId: number }).actionId
    actions.get(actionId)!.status = 'success'; await handleServerSync(ctx, { serverId: p.server.id })
    const secondSession = await createSession(ctx.db, p.user.id, {})
    const claim = (token: string) => app.inject({ method: 'POST', url: `/api/servers/${p.server.id}/credentials/claim`, headers: { authorization: `Bearer ${token}` }, payload: { operationId: id } })
    expect((await claim(secondSession.token)).statusCode).toBe(409)
    const result = await claim(p.session.token); expect(result.statusCode).toBe(200); expect(result.json().data.password).toBe('Fixture-sensitive-root-password!')
    expect(result.headers['cache-control']).toBe('no-store'); expect((await claim(p.session.token)).statusCode).toBe(409)
    expect((await ctx.db.query.serverSecrets.findFirst({ where: t => eq(t.id, secret.id) }))!.encrypted).toBeNull()
    const history = await app.inject({ url: `/api/servers/${p.server.id}/management`, headers: p.headers })
    expect(history.body).not.toMatch(/Fixture-sensitive|fixture-project-secret|fixture-private-user-data|encrypted/)
  })
  it('validates resize previews, rejects client pricing and changes only future billing after provider confirmation', async () => {
    const p = await buy(); await activate(p)
    const offer = await findOfferByProductAndLocation(ctx.db, 'hetzner', 'cx-fixture-large:EUR', 'hel1')
    const url = `/api/servers/${p.server.id}/resize-preview`, payload = { offerId: offer!.id, upgradeDisk: true }
    expect((await app.inject({ method: 'POST', url, headers: p.headers, payload })).statusCode).toBe(422)
    machines.get(p.providerId)!.status = 'off'; await handleServerSync(ctx, { serverId: p.server.id })
    const response = await app.inject({ method: 'POST', url, headers: p.headers, payload })
    expect(response.statusCode, response.body).toBe(200)
    const preview = response.json().data, sub = (await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.serverId, p.server.id) }))!
    expect(preview).toMatchObject({ currentPriceRial: sub.priceRial, immediateChargeRial: 0, serverType: largerType.name })
    expect(preview.priceRial).toBeGreaterThan(sub.priceRial)
    const resizeKey = randomUUID()
    const submit = (extra = {}) => app.inject({ method: 'POST', remoteAddress: p.remoteAddress, url: `/api/servers/${p.server.id}/management/actions`, headers: { ...p.headers, 'idempotency-key': resizeKey }, payload: { action: 'resize', quoteId: preview.quoteId, upgradeDisk: true, hostname: 'fixture-server', confirm: true, ...extra } })
    expect((await submit({ priceRial: 1 })).statusCode).toBe(422)
    machines.get(p.providerId)!.status = 'running'
    expect((await submit()).statusCode).toBe(422)
    machines.get(p.providerId)!.status = 'off'
    const accepted = await submit(); expect(accepted.statusCode, accepted.body).toBe(202)
    const id = accepted.json().data.id, balance = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))!.balanceRial
    await ctx.db.update(idempotencyKeys).set({ expiresAt: new Date(0) }).where(eq(idempotencyKeys.key, preview.quoteId))
    expect((await submit()).json().data.id).toBe(id)
    expect((await submit({ upgradeDisk: false })).statusCode).toBe(409)
    await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'resize' })
    const op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!, actionId = (op.responseMetadata as { actionId: number }).actionId
    expect((await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, sub.id) }))!.priceRial).toBe(sub.priceRial)
    machines.get(p.providerId)!.server_type = largerType; machines.get(p.providerId)!.primary_disk_size = 80
    actions.get(actionId)!.status = 'success'; await handleServerSync(ctx, { serverId: p.server.id })
    expect((await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.id, sub.id) }))!.priceRial).toBe(preview.priceRial)
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))!.balanceRial).toBe(balance)
    expect((await ctx.db.query.invoices.findFirst({ where: t => eq(t.orderId, p.orderId) }))!.totalRial).toBe(sub.priceRial)
    expect(await ctx.db.query.subscriptionEvents.findFirst({ where: t => eq(t.subscriptionId, sub.id) })).toBeTruthy()
  })
  it('rechecks a shutdown without dispatching it again and unlocks resize only after confirmed shutdown', async () => {
    const p = await buy(); await activate(p)
    const operationId = await action(p, 'power_off')
    await handleServerAction(ctx, { operationId, serverId: p.server.id, action: 'power_off' })
    const op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, operationId) }))!
    const actionId = (op.responseMetadata as { actionId: number }).actionId
    await ctx.db.update(providerOperations).set({ status: 'unknown' }).where(eq(providerOperations.id, operationId))
    const serverUrl = `/api/servers/${p.server.id}`
    const check = (id = operationId) => app.inject({ method: 'POST', url: `${serverUrl}/management/operations/${id}/recheck`, headers: p.headers, remoteAddress: p.remoteAddress })
    const offer = await findOfferByProductAndLocation(ctx.db, 'hetzner', 'cx-fixture-large:EUR', 'hel1')
    const preview = () => app.inject({ method: 'POST', url: `${serverUrl}/resize-preview`, headers: p.headers, payload: { offerId: offer!.id, upgradeDisk: false } })
    expect((await check(randomUUID())).statusCode).toBe(404)
    const another = await buy()
    expect((await app.inject({ method: 'POST', url: `${serverUrl}/management/operations/${operationId}/recheck`, headers: another.headers })).statusCode).toBe(404)
    const receipt = actions.get(actionId)!
    actions.delete(actionId)
    expect((await check()).json().data).toMatchObject({ checkFailed: true, operation: { status: 'outcome_unknown' } })
    actions.set(actionId, receipt)
    expect((await check()).json().data).toMatchObject({ checkFailed: false, operation: { status: 'outcome_unknown' } })
    receipt.status = 'success'
    expect((await check()).json().data.operation.status).toBe('outcome_unknown')
    expect((await preview()).statusCode).toBe(409)
    machines.get(p.providerId)!.status = 'off'
    expect((await check()).json().data.operation.status).toBe('confirmed')
    expect((await check()).json().data.operation.status).toBe('confirmed')
    expect((await app.inject({ url: `${serverUrl}/management?refresh=1`, headers: p.headers })).json().data)
      .toMatchObject({ providerState: 'suspended', resizeBlock: null })
    const quote = await preview()
    expect(quote.statusCode, quote.body).toBe(200)
    expect(calls.filter(c => c.method === 'POST' && c.path === `/servers/${p.providerId}/actions/poweroff`)).toHaveLength(1)
  })
  it('caches real metric samples without converting unavailable data to zero', async () => {
    const p = await buy(); await activate(p)
    const url = `/api/servers/${p.server.id}/metrics?window=6h`, before = calls.filter(c => c.path.endsWith('/metrics')).length
    const first = await app.inject({ url, headers: p.headers }), second = await app.inject({ url, headers: p.headers })
    expect(first.statusCode, first.body).toBe(200); expect(second.json()).toEqual(first.json())
    expect(first.json().data.series.cpu).toEqual([[100, 15], [160, null], [220, null], [280, 0]])
    expect(calls.filter(c => c.path.endsWith('/metrics')).length - before).toBe(1)
    expect((await app.inject({ url: `/api/servers/${p.server.id}/metrics?window=100h`, headers: p.headers })).statusCode).toBe(422)
  })
  it('fails a queued start safely if funds disappear before dispatch and blocks stale jobs after confirmed deletion', async () => {
    const p = await buy(); await activate(p)
    machines.get(p.providerId)!.status = 'off'; await handleServerSync(ctx, { serverId: p.server.id })
    const id = await action(p, 'power_on')
    await ctx.db.update(wallets).set({ balanceRial: 0 }).where(eq(wallets.id, p.wallet.id))
    const before = calls.filter(c => c.method !== 'GET').length
    await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'power_on' })
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!).toMatchObject({ status: 'failed', lastError: 'insufficient funding before provider dispatch' })
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(before)
    const deleteId = await action(p, 'delete'); machines.delete(p.providerId)
    await handleServerAction(ctx, { operationId: deleteId, serverId: p.server.id, action: 'delete' })
    await ctx.db.insert(providerOperations).values({ provider: 'hetzner', kind: 'server_management', action: 'power_on', referenceType: 'server', referenceId: p.server.id, businessKey: `fixture-stale:${randomUUID()}`, status: 'pending', requestMetadata: { providerServerId: p.server.providerServerId } })
    const stale = (await ctx.db.query.providerOperations.findMany({ where: t => eq(t.referenceId, p.server.id) })).find(op => op.status === 'pending')!
    await handleServerAction(ctx, { operationId: stale.id, serverId: p.server.id, action: 'power_on' })
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, stale.id) }))!.status).toBe('failed')
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(before)
  })
  it('does not grant another customer management, order tracking or console access', async () => {
    const p = await buy(), other = await buy(); await activate(p)
    for (const path of [`/servers/${p.server.id}/management`, `/servers/provisioning/${p.orderId}`, `/servers/${p.server.id}/metrics`]) expect((await app.inject({ url: `/api${path}`, headers: other.headers })).statusCode).toBe(404)
    const denied = await app.inject({ method: 'POST', url: `/api/servers/${p.server.id}/console`, headers: { cookie: `cloud_session=${other.session.token}` }, payload: {} })
    expect(denied.statusCode).toBe(404)
    expect(calls.filter(c => c.method !== 'GET').every(c => c.account === 'Bearer fixture-project-secret')).toBe(true)
  })
  it('enforces live delete protection, image eligibility and confirmed rebuild output', async () => {
    const p = await buy(); await activate(p)
    machines.get(p.providerId)!.protection = { delete: true, rebuild: false }
    const deletion = await action(p, 'delete'), before = calls.filter(c => c.method === 'DELETE').length
    await handleServerAction(ctx, { operationId: deletion, serverId: p.server.id, action: 'delete' })
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(before)
    expect((await ctx.db.query.servers.findFirst({ where: t => eq(t.id, p.server.id) }))!.terminationState).toBe('delete_failed')
    const rebuild = (image: string) => app.inject({ method: 'POST', remoteAddress: p.remoteAddress, url: `/api/servers/${p.server.id}/management/actions`, headers: { ...p.headers, 'idempotency-key': randomUUID() }, payload: { action: 'rebuild', image, hostname: 'fixture-server', confirm: true } })
    const invalid = await rebuild('999'), invalidId = invalid.json().data.id
    await handleServerAction(ctx, { operationId: invalidId, serverId: p.server.id, action: 'rebuild' })
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, invalidId) }))!.status).toBe('failed')
    const accepted = await rebuild('11'); expect(accepted.statusCode, accepted.body).toBe(202)
    const id = accepted.json().data.id
    await handleServerAction(ctx, { operationId: id, serverId: p.server.id, action: 'rebuild' })
    const claim = () => app.inject({ method: 'POST', url: `/api/servers/${p.server.id}/credentials/claim`, headers: p.headers, payload: { operationId: id } })
    expect((await claim()).statusCode).toBe(409)
    const op = (await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, id) }))!
    actions.get((op.responseMetadata as { actionId: number }).actionId)!.status = 'success'
    await handleServerSync(ctx, { serverId: p.server.id })
    expect((await claim()).json().data.password).toBe('Fixture-sensitive-root-password!')
  })
  it('authorizes a one-use console by account, session and Origin and relays binary frames without exposing the provider URL', async () => {
    const p = await buy(); await activate(p)
    const response = await app.inject({ method: 'POST', url: `/api/servers/${p.server.id}/console`, headers: { cookie: `cloud_session=${p.session.token}` }, payload: {} })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).not.toContain('wss://')
    const grant = response.json().data, path = `/api/servers/${p.server.id}/console/${grant.grantId}`
    const headers = { cookie: `cloud_session=${p.session.token}`, host: 'app.test', origin: 'https://app.test' }
    const upgrade = (headers: Record<string, string>) => ({ headers, socket: Object.defineProperty(new Socket(), 'remoteAddress', { value: '192.0.2.111' }) })
    await expect(app.injectWS(path, upgrade({ ...headers, origin: 'https://foreign.test' }))).rejects.toThrow(/403/)
    const second = await createSession(ctx.db, p.user.id, {})
    await expect(app.injectWS(path, upgrade({ ...headers, cookie: `cloud_session=${second.token}` }))).rejects.toThrow(/403/)
    openSocket.mockImplementation(() => {
      const events = new EventEmitter()
      const socket = Object.assign(events, { readyState: 1, bufferedAmount: 0, send(data: Buffer) { events.emit('message', data, true) }, close() { socket.readyState = 3; events.emit('close') } })
      queueMicrotask(() => socket.emit('open')); return socket
    })
    const socket = await app.injectWS(path, upgrade(headers))
    const received = once(socket, 'message'); socket.send(Buffer.from('fixture-rfb-frame'))
    expect((await received)[0].toString()).toBe('fixture-rfb-frame')
    const closed = once(socket, 'close'); socket.close(); await closed
    expect(openSocket).toHaveBeenCalledTimes(1)
    const stored = (await ctx.db.query.serverSecrets.findFirst({ where: t => eq(t.id, grant.grantId) }))!
    expect(stored.encrypted).toBeNull(); expect(stored.claimedAt).toBeTruthy()
    await expect(app.injectWS(path, upgrade(headers))).rejects.toThrow(/403/)
  })
  it('keeps receipt-less legacy shutdown locked until an admin verifies terminal evidence, then allows safe owner deletion', async () => {
    const p = await buy(); await activate(p)
    const admin = await registerUser(ctx.db, { email: `operator-${randomUUID()}@fixture.test`, password: 'Fixture-customer-123!' })
    await ctx.db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id))
    const adminSession = await createSession(ctx.db, admin.id, {})
    const adminHeaders = { authorization: `Bearer ${adminSession.token}` }
    const started = new Date(Date.now() - 3_600_000)
    const [op] = await ctx.db.insert(providerOperations).values({ provider: 'hetzner', kind: 'server_action', action: 'power_off',
      referenceType: 'server', referenceId: p.server.id, businessKey: randomUUID(), status: 'unknown', attemptCount: 1,
      createdAt: started, updatedAt: new Date(started.getTime() + 30_000), lastError: 'Hetzner mutation outcome is unknown' }).returning()
    const opId = op!.id, actionId = 424242
    const owner = { headers: p.headers, remoteAddress: p.remoteAddress }
    const serverUrl = `/api/servers/${p.server.id}`, adminUrl = `/api/admin/console/servers/${p.server.id}/legacy-power/${opId}`
    const review = () => app.inject({ url: adminUrl, headers: adminHeaders })
    const resolve = () => app.inject({ method: 'POST', url: adminUrl, headers: adminHeaders, payload: { actionId, note: 'Verified owning project receipt and original dispatch time' } })
    const recheck = () => app.inject({ method: 'POST', url: `${serverUrl}/management/operations/${opId}/recheck`, ...owner })
    const worker = () => handleServerAction(ctx, { operationId: opId, serverId: p.server.id, action: 'power_off' })
    const requestDelete = () => app.inject({ method: 'POST', url: `${serverUrl}/management/actions`, ...owner,
      headers: { ...p.headers, 'idempotency-key': randomUUID() }, payload: { action: 'delete', hostname: 'fixture-server', confirm: true } })
    expect((await requestDelete()).statusCode).toBe(409)
    expect((await app.inject({ url: adminUrl, ...owner })).statusCode).toBe(403)
    expect((await review()).json().data).toEqual({ state: 'active', candidates: [] })
    expect((await resolve()).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/admin/provider-operations/${opId}/mark-rejected`, headers: adminHeaders, payload: {} })).statusCode).toBe(409)
    expect(await handleReconcile(ctx, { operationId: opId })).toEqual({ resolved: 0, underReview: 0 })
    const [checkA, checkB] = await Promise.all([recheck(), recheck(), worker()])
    for (const result of [checkA, checkB]) expect(result.json().data.operation).toMatchObject({ status: 'outcome_unknown', needsOperator: true })
    actions.set(actionId, { id: actionId, command: 'stop_server', status: 'running', started: started.toISOString(), resources: [{ type: 'server', id: p.providerId }] })
    expect((await resolve()).statusCode).toBe(409)
    Object.assign(actions.get(actionId)!, { status: 'error', finished: new Date(started.getTime() + 5_000).toISOString() })
    const [first, second] = await Promise.all([resolve(), resolve(), recheck(), worker()])
    expect([first, second].map(result => result.statusCode)).toEqual([200, 200])
    expect((await recheck()).json().data.operation.status).toBe('failed')
    expect(await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, opId) })).toMatchObject({
      status: 'failed', attemptCount: 1, responseMetadata: { operatorResolution: { actionId, actorId: admin.id, providerStatus: 'error', observedState: 'active' } },
    })
    expect((await ctx.db.query.auditLogs.findMany({ where: t => eq(t.targetId, opId) })).filter(row => row.action === 'admin.legacy_power_operation.resolved')).toHaveLength(1)
    expect((await app.inject({ method: 'POST', url: `/api/admin/provider-operations/${opId}/retry`, headers: adminHeaders })).statusCode).toBe(409)
    expect(calls.filter(c => c.path === `/servers/${p.providerId}/actions`).every(c => c.method === 'GET' && c.account === 'Bearer fixture-project-secret')).toBe(true)
    expect(calls.filter(c => c.path === `/servers/${p.providerId}/actions/poweroff`)).toHaveLength(0)
    const deleted = await requestDelete()
    expect(deleted.statusCode, deleted.body).toBe(202)
    const deletionId = deleted.json().data.id
    const balance = (await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))!.balanceRial
    try {
      loseDeleteResponse = true
      await handleServerAction(ctx, { operationId: deletionId, serverId: p.server.id, action: 'delete' })
    } finally { loseDeleteResponse = false }
    await handleServerSync(ctx, { serverId: p.server.id })
    expect((await ctx.db.query.servers.findFirst({ where: t => eq(t.id, p.server.id) }))?.status).toBe('terminated')
    expect(await ctx.db.query.subscriptions.findFirst({ where: t => eq(t.serverId, p.server.id) })).toMatchObject({ status: 'cancelled', autoRenew: false })
    expect((await ctx.db.query.wallets.findFirst({ where: t => eq(t.id, p.wallet.id) }))?.balanceRial).toBe(balance)
    expect((await ctx.db.query.invoices.findFirst({ where: t => eq(t.orderId, p.orderId) }))?.status).toBe('paid')
    expect(calls.filter(c => c.method === 'DELETE' && c.path === `/servers/${p.providerId}`)).toHaveLength(1)
  })

  it('recovers an old power-off with no Hetzner action so the owner can request deletion without a ticket', async () => {
    const p = await buy(); await activate(p)
    const started = new Date(Date.now() - 60 * 60_000)
    const [orphan] = await ctx.db.insert(providerOperations).values({
      provider: 'hetzner', kind: 'server_action', action: 'power_off', referenceType: 'server',
      referenceId: p.server.id, businessKey: randomUUID(), status: 'unknown', attemptCount: 1,
      createdAt: started, updatedAt: new Date(started.getTime() + 60_000),
      lastError: 'Hetzner mutation outcome is unknown',
    }).returning()
    const oldCreation = new Date(started.getTime() - 2 * 60_000), creationId = 800000 + p.providerId
    actions.set(creationId, { id: creationId, command: 'create_server', status: 'success',
      started: oldCreation.toISOString(), finished: new Date(oldCreation.getTime() + 8_000).toISOString(),
      resources: [{ type: 'server', id: p.providerId }] })

    const url = '/api/servers/' + p.server.id
    const recheck = () => app.inject({ method: 'POST', url: url + '/management/operations/' + orphan!.id + '/recheck',
      headers: p.headers, remoteAddress: p.remoteAddress })
    const deleteServer = () => app.inject({ method: 'POST', url: url + '/management/actions',
      headers: { ...p.headers, 'idempotency-key': randomUUID() }, remoteAddress: p.remoteAddress,
      payload: { action: 'delete', hostname: 'fixture-server', confirm: true } })
    expect((await deleteServer()).statusCode).toBe(409)
    const [a, b] = await Promise.all([recheck(), recheck()])
    expect(a.statusCode, a.body).toBe(200)
    expect(b.statusCode, b.body).toBe(200)
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, orphan!.id) })))
      .toMatchObject({ status: 'failed', responseMetadata: { recoveryEvidence: {
        type: 'exhaustive_no_dispatch', historyCount: 1, creationActionId: creationId,
        observedState: 'active', matchingActionsSinceRequest: 0,
      } } })
    const audit = await ctx.db.query.auditLogs.findMany({ where: t => eq(t.targetId, orphan!.id) })
    expect(audit.filter(row => row.action === 'server.legacy_power_off.no_dispatch_verified')).toHaveLength(1)
    const result = await deleteServer()
    expect(result.statusCode, result.body).toBe(202)
    expect(calls.filter(c => c.method === 'POST' && c.path === '/servers/' + p.providerId + '/actions/poweroff')).toHaveLength(0)
  })

  it('retains the legacy lock when the provider history includes a later server action', async () => {
    const p = await buy(); await activate(p)
    const started = new Date(Date.now() - 60 * 60_000)
    const [orphan] = await ctx.db.insert(providerOperations).values({
      provider: 'hetzner', kind: 'server_action', action: 'power_off', referenceType: 'server',
      referenceId: p.server.id, businessKey: randomUUID(), status: 'unknown', attemptCount: 1,
      createdAt: started, updatedAt: new Date(started.getTime() + 60_000),
    }).returning()
    const before = new Date(started.getTime() - 120_000), after = new Date(started.getTime() + 30_000)
    const creationId = 810000 + p.providerId, laterId = creationId + 1
    actions.set(creationId, { id: creationId, command: 'create_server', status: 'success',
      started: before.toISOString(), finished: new Date(before.getTime() + 5_000).toISOString(),
      resources: [{ type: 'server', id: p.providerId }] })
    actions.set(laterId, { id: laterId, command: 'start_server', status: 'success',
      started: after.toISOString(), finished: new Date(after.getTime() + 5_000).toISOString(),
      resources: [{ type: 'server', id: p.providerId }] })
    const recheck = await app.inject({ method: 'POST', url: '/api/servers/' + p.server.id +
      '/management/operations/' + orphan!.id + '/recheck', headers: p.headers, remoteAddress: p.remoteAddress })
    expect(recheck.statusCode).toBe(200)
    expect(recheck.json().data.operation.status).toBe('outcome_unknown')
    expect((await ctx.db.query.providerOperations.findFirst({ where: t => eq(t.id, orphan!.id) }))!.completedAt).toBeNull()
  })

  it('reports console eligibility and revokes an unused grant only for its browser session', async () => {
    const p = await buy(); await activate(p)
    const url = `/api/servers/${p.server.id}`
    const cookie = { cookie: `cloud_session=${p.session.token}` }
    const browser = { headers: cookie, remoteAddress: p.remoteAddress }
    const detail = (headers: Record<string, string>) => app.inject({ url: `${url}/management`, headers, remoteAddress: p.remoteAddress })
    expect((await detail(p.headers)).json().data.consoleBlock).toBe('browser_session_required')
    expect((await detail(cookie)).json().data.consoleBlock).toBeNull()
    const second = await createSession(ctx.db, p.user.id, {})
    const secondCookie = { cookie: `cloud_session=${second.token}` }
    const mismatch = await app.inject({ method: 'POST', url: `${url}/console`, payload: {}, ...browser, headers: { ...secondCookie, ...p.headers } })
    expect(mismatch.statusCode).toBe(403)
    const created = await app.inject({ method: 'POST', url: `${url}/console`, payload: {}, ...browser })
    expect(created.statusCode).toBe(200)
    const { grantId } = created.json().data
    const grantUrl = `${url}/console/${grantId}`
    const loadGrant = () => ctx.db.query.serverSecrets.findFirst({ where: t => eq(t.id, grantId) })
    await app.inject({ method: 'DELETE', url: grantUrl, ...browser, headers: secondCookie })
    expect((await loadGrant())?.encrypted).toBeTruthy()
    expect((await app.inject({ method: 'DELETE', url: grantUrl, ...browser })).statusCode).toBe(204)
    expect((await loadGrant())?.encrypted).toBeNull()
    await expect(app.injectWS(grantUrl, { headers: { ...cookie, origin: 'https://app.test', host: 'app.test' },
      socket: Object.defineProperty(new Socket(), 'remoteAddress', { value: '192.0.2.113' }) })).rejects.toThrow(/403/)
    await action(p, 'power_off')
    expect((await detail(cookie)).json().data.consoleBlock).toBe('operation_pending')
    expect((await app.inject({ method: 'POST', url: `${url}/console`, payload: {}, ...browser })).statusCode).toBe(409)
  })
})
