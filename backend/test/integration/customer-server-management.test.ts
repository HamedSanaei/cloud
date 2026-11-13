import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { Socket } from 'node:net'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { HetznerConfig } from '../../src/config.js'
import { buildApp } from '../../src/app.js'
import { createHetznerProvider } from '../../src/modules/providers/hetzner/live.js'
import { registerProvider } from '../../src/modules/providers/registry.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { creditWallet, ensureDefaultWallet } from '../../src/modules/wallets/service.js'
import { syncProviderCatalog, enableAllOffersForSale, findOfferByProductAndLocation } from '../../src/modules/catalog/service.js'
import { setFxRate } from '../../src/modules/pricing/service.js'
import { handleProvision, handleRenewalSweep, handleServerAction, handleServerSync } from '../../src/modules/provisioning/handlers.js'
import { idempotencyKeys, providerOperations, subscriptions, wallets } from '../../src/db/schema.js'
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
  const type = { id: 1, name: 'cx-fixture', architecture: 'x86', storage_type: 'local', cores: 2, memory: 4, disk: 40,
    locations: [{ name: 'hel1', available: true }], prices: [{ location: 'hel1', price_hourly: { gross: '0.0044' }, price_monthly: { gross: '3.79' } }] }
  const largerType = { ...type, id: 2, name: 'cx-fixture-large', cores: 4, memory: 8, disk: 80, prices: [{ location: 'hel1', price_hourly: { gross: '0.0088' }, price_monthly: { gross: '7.58' } }] }
  const fetcher: typeof fetch = async (url, init) => {
    const request = new URL(String(url)); expect(request.origin).toBe('https://provider.test')
    const path = request.pathname.replace('/v1', ''), method = init?.method ?? 'GET', account = new Headers(init?.headers).get('authorization') ?? ''
    calls.push({ method, path, account })
    const json = (data: unknown) => Response.json(data)
    if (path === '/server_types') return json({ server_types: [type, largerType] })
    if (path === '/locations') return json({ locations: [{ name: 'hel1', country: 'FI', city: 'Helsinki' }] })
    if (path === '/pricing') return json({ pricing: { currency: 'EUR', primary_ips: [{ type: 'ipv4', prices: [{ location: 'hel1', price_hourly: { gross: '0.0008' } }] }] } })
    if (path === '/images') return json({ images: [{ id: 11, name: 'ubuntu-24.04', architecture: 'x86', type: 'system', status: 'available' }] })
    if (/^\/servers\/\d+\/metrics$/.test(path)) return json({ metrics: { time_series: { cpu: { values: [[100, '15'], [160, null], [220, 'NaN'], [280, '0']] }, 'network.0.bandwidth.in': { values: [[100, '42']] } } } })
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
    expect(await ctx.db.query.notifications.findMany({ where: t => eq(t.eventKey, `server-operation:${id}:succeeded`) })).toEqual([
      expect.objectContaining({ userId: p.user.id, title: 'سرور خاموش شد', href: `/servers/${p.server.id}?tab=operations` }),
    ])
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
})
