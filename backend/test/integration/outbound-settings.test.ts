import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import * as config from '../../src/config.js'
import * as policy from '../../src/modules/outbound/policy.js'
import { buildApp } from '../../src/app.js'
import { settings, users, auditLogs, systemEvents } from '../../src/db/schema.js'
import { registerUser, createSession } from '../../src/modules/auth/service.js'
import { readOutbound, outboundKey } from '../../src/modules/outbound/settings.js'
import { OutboundHttp } from '../../src/modules/outbound/client.js'
import { recordEvent } from '../../src/modules/system/events.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

const base = '/api/admin/settings', healthKey = 'network.outbound.health.v1'
describe.skipIf(!dbAvailable)('admin outbound settings and shared runtime policy', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>, app: FastifyInstance, c: ReturnType<typeof config.getConfig>, n = 0
  beforeAll(async () => {
    ctx = await getTestContext(); await truncateAll(ctx.db)
    await ctx.db.delete(settings).where(eq(settings.key, outboundKey)); await ctx.db.delete(settings).where(eq(settings.key, healthKey))
    c = { ...config.getConfig(), DATA_AUTHORITY: 'site', STORE_SECRET_KEY: '', SYSTEM_BACKUP_ENABLED: false }
    vi.spyOn(config, 'getConfig').mockImplementation(() => c)
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger }); await app.ready()
  })
  afterEach(() => { vi.unstubAllGlobals() })
  afterAll(async () => {
    await app?.close()
    if (ctx) { await ctx.db.delete(settings).where(eq(settings.key, outboundKey)); await ctx.db.delete(settings).where(eq(settings.key, healthKey)); await ctx.close() }
    vi.restoreAllMocks()
  })
  async function account(role: 'super_admin' | 'user' = 'super_admin') {
    const user = await registerUser(ctx.db, { email: `outbound-${++n}@fixture.test`, password: 'Fixture-network-123!' })
    await ctx.db.update(users).set({ role }).where(eq(users.id, user.id))
    const session = await createSession(ctx.db, user.id, {})
    return { id: user.id, headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, remoteAddress: `192.0.2.${n}` }
  }
  type Account = Awaited<ReturnType<typeof account>>
  const send = (actor: Account, method: 'GET' | 'POST', path: string, payload?: unknown) => app.inject({ method, url: base + path,
    payload: payload === undefined ? undefined : JSON.stringify(payload), headers: actor.headers, remoteAddress: actor.remoteAddress })
  const status = async (actor: Account) => (await send(actor, 'GET', '/outbound')).json().data
  async function authorize(actor: Account, action: string, payload: object) {
    const r = await send(actor, 'POST', '/authorize', { action, payload }); expect(r.statusCode, r.body).toBe(200); return r.json().data.proof as string
  }
  async function perform(actor: Account, action: string, path: string, payload: object) {
    const proof = await authorize(actor, action, payload)
    return send(actor, 'POST', path, { ...payload, proof })
  }
  async function profile(actor: Account) {
    const snapshot = await status(actor)
    const input = { revision: snapshot.revision, name: `Fixture proxy ${n}`, type: 'socks5', host: '8.8.8.8', port: 1080,
      timeoutMs: 1000, enabled: true, username: 'fixture-user', password: 'fixture-secret', confirm: true }
    const r = await perform(actor, 'outbound.profile', '/outbound/profiles', input)
    expect(r.statusCode, r.body).toBe(200); return { ...r.json().data, input }
  }
  it('uses existing admin access and denies anonymous/regular users including proof issuance', async () => {
    expect((await app.inject(base + '/outbound')).statusCode).toBe(401)
    expect((await send(await account(), 'GET', '/outbound')).statusCode).toBe(200)
    for (const actor of [await account('user')]) {
      expect((await send(actor, 'GET', '/outbound')).statusCode).toBe(403)
      expect((await send(actor, 'POST', '/authorize', { action: 'outbound.test', payload: { revision: 'initial', integration: 'hetzner', confirm: true } })).statusCode).toBe(403)
      expect((await send(actor, 'POST', '/outbound/test', { revision: 'initial', integration: 'hetzner', confirm: true, proof: randomUUID() })).statusCode).toBe(403)
    }
  })
  it('starts direct and encrypts/masks credentials without a separate store key', async () => {
    const actor = await account()
    const initial = await status(actor)
    expect(initial.profiles).toEqual([])
    expect(initial.integrations.every((i: any) => i.active.route === 'direct')).toBe(true)
    const saved = await profile(actor), view = await status(actor)
    expect(view.profiles[0].authenticated).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/fixture-user|fixture-secret|"password"|"username"/)
    const stored = await ctx.db.query.settings.findFirst({ where: t => eq(t.key, outboundKey) })
    expect(JSON.stringify(stored?.value)).not.toMatch(/fixture-secret|fixture-user|8\.8\.8\.8/)
    expect((await readOutbound(ctx.db)).profiles.find(p => p.id === saved.id)?.password).toBe('fixture-secret')
    const audit = await ctx.db.select().from(auditLogs).where(eq(auditLogs.actorId, actor.id))
    expect(JSON.stringify(audit)).not.toMatch(/fixture-user|fixture-secret/)
  })
  it('binds a proof to exact payload and one use and rejects stale edits', async () => {
    const actor = await account(), saved = await profile(actor)
    const input = { ...saved.input, id: saved.id, revision: saved.revision, username: undefined, password: undefined, enabled: false }
    const proof = await authorize(actor, 'outbound.profile', input)
    expect((await send(actor, 'POST', '/outbound/profiles', { ...input, port: 1081, proof })).statusCode).toBe(403)
    expect((await send(actor, 'POST', '/outbound/profiles', { ...input, proof })).statusCode).toBe(200)
    expect((await send(actor, 'POST', '/outbound/profiles', { ...input, proof })).statusCode).toBe(403)
    expect((await perform(actor, 'outbound.profile', '/outbound/profiles', input)).statusCode).toBe(409)
    expect((await readOutbound(ctx.db)).profiles.find(p => p.id === saved.id)?.password).toBe('fixture-secret')
  })
  it('rechecks the existing database role after proof issuance', async () => {
    const actor = await account(), input = { revision: (await status(actor)).revision, integration: 'hetzner', confirm: true }
    const proof = await authorize(actor, 'outbound.test', input)
    await ctx.db.update(users).set({ role: 'user' }).where(eq(users.id, actor.id))
    expect((await send(actor, 'POST', '/outbound/test', { ...input, proof })).statusCode).toBe(403)
  })
  it('feeds independent API/worker readers, keeps domestic routes direct and blocks disabled required profiles', async () => {
    const actor = await account(), saved = await profile(actor)
    const payload = { revision: saved.revision, integration: 'hetzner', enabled: true, profileId: saved.id, failurePolicy: 'closed', confirm: true }
    expect((await perform(actor, 'outbound.route', '/outbound/routes', payload)).statusCode).toBe(200)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ locations: [] })))
    const api = new OutboundHttp(() => readOutbound(ctx.db)), worker = new OutboundHttp(() => readOutbound(ctx.db))
    try {
      expect((await api.request('hetzner', policy.testTargets.hetzner.url)).report.route).toBe('proxy')
      expect((await worker.request('hetzner', policy.testTargets.hetzner.url)).report.route).toBe('proxy')
      expect((await api.request('parsgreen', policy.testTargets.parsgreen.url)).report.route).toBe('direct')
      const snapshot = await status(actor)
      expect((await perform(actor, 'outbound.profile', '/outbound/profiles', { ...saved.input, id: saved.id, revision: snapshot.revision, enabled: false })).statusCode).toBe(200)
      await expect(api.request('hetzner', policy.testTargets.hetzner.url)).rejects.toMatchObject({ category: 'configuration' })
      await expect(worker.request('hetzner', policy.testTargets.hetzner.url)).rejects.toMatchObject({ category: 'configuration' })
      const next = await status(actor)
      expect((await perform(actor, 'outbound.route', '/outbound/routes', { ...payload, revision: next.revision, enabled: false })).statusCode).toBe(200)
      expect((await worker.request('hetzner', policy.testTargets.hetzner.url)).report.route).toBe('direct')
    } finally { await api.close(); await worker.close() }
  })
  it('refuses deleting an in-use profile, then supports revoke, retirement and credential clearing', async () => {
    const actor = await account(), saved = await profile(actor)
    const profileEdit = { ...saved.input, id: saved.id, revision: saved.revision, username: undefined, password: undefined, clearCredentials: true }
    const cleared = await perform(actor, 'outbound.profile', '/outbound/profiles', profileEdit)
    expect(cleared.statusCode).toBe(200)
    expect((await readOutbound(ctx.db)).profiles.find(p => p.id === saved.id)?.username).toBe('')
    const route = { revision: cleared.json().data.revision, integration: 'leaseweb', enabled: true, profileId: saved.id, failurePolicy: 'closed', confirm: true }
    const linked = await perform(actor, 'outbound.route', '/outbound/routes', route)
    expect(linked.statusCode).toBe(200)
    expect((await perform(actor, 'outbound.delete', '/outbound/profiles/delete', { revision: linked.json().data.revision, id: saved.id, confirm: true })).statusCode).toBe(409)
    const unlinked = await perform(actor, 'outbound.route', '/outbound/routes', { ...route, revision: linked.json().data.revision, enabled: false })
    expect(unlinked.statusCode).toBe(200)
    // A separate session/IP is not needed; this new proof is granted after a fresh fixture actor is created.
    const other = await account()
    expect((await perform(other, 'outbound.delete', '/outbound/profiles/delete', { revision: unlinked.json().data.revision, id: saved.id, confirm: true })).statusCode).toBe(200)
    expect((await status(other)).profiles.some((p: any) => p.id === saved.id)).toBe(false)
  })
  it('runs only fixed non-mutating diagnostic endpoints, reports the actual route and preserves last success', async () => {
    const actor = await account(), saved = await profile(actor)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ locations: [] })))
    const payload = { revision: saved.revision, integration: 'hetzner', profileId: saved.id, confirm: true }
    const tested = await perform(actor, 'outbound.test', '/outbound/test', payload)
    expect(tested.statusCode, tested.body).toBe(200)
    expect(tested.json().data).toMatchObject({ ok: true, route: 'proxy', profileId: saved.id, category: 'none' })
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => ['GET', 'HEAD'].includes(init?.method ?? 'GET'))).toBe(true)
    expect(JSON.stringify(vi.mocked(fetch).mock.calls.map(([, init]) => init?.headers))).not.toContain('fixture-secret')
    vi.mocked(fetch).mockRejectedValue(new Error('proxy credentials fixture-secret'))
    const failed = await perform(actor, 'outbound.test', '/outbound/test', payload)
    expect(failed.json().data).toMatchObject({ ok: false, route: 'proxy', category: 'unreachable', lastSuccessAt: tested.json().data.testedAt })
    expect(failed.body).not.toContain('fixture-secret')
    const view = await status(actor)
    expect(view.profiles.find((p: any) => p.id === saved.id).lastTest.ok).toBe(false)
    expect((await send(actor, 'POST', '/outbound/test', { ...payload, proof: randomUUID(), url: 'http://169.254.169.254/' })).statusCode).toBe(422)
  })
  it('persists the Google route and the results of both unauthenticated diagnostics', async () => {
    const actor = await account(), saved = await profile(actor)
    vi.stubGlobal('fetch', vi.fn(async url => new Response(null, { status: url === policy.googleTargets.tokenProbe ? 400 : 401 })))
    const integration = 'google'
    const route = await perform(actor, 'outbound.route', '/outbound/routes', {
      revision: saved.revision, integration, profileId: saved.id, enabled: true, failurePolicy: 'closed', confirm: true,
    })
    expect(route.statusCode, route.body).toBe(200)
    const tested = await perform(actor, 'outbound.test', '/outbound/test', { revision: route.json().data.revision, integration, confirm: true })
    expect(tested.statusCode, tested.body).toBe(200)
    expect(tested.json().data).toMatchObject({ route: 'proxy', ok: true, checks: [
      { name: 'token', ok: true, httpStatus: 400 }, { name: 'userinfo', ok: true, httpStatus: 401 },
    ] })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([policy.googleTargets.tokenProbe, policy.googleTargets.userinfo])
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true)
    const entry = (await status(actor)).integrations.find((item: { id: string }) => item.id === integration)
    expect(entry.active.route).toBe('proxy')
    expect(entry.lastTest).toEqual(tested.json().data)
  })
  it('keeps the last console failure after success and redacts secrets from health status', async () => {
    const actor = await account(), snapshot = await status(actor)
    const metadata = { integration: 'hetzner', route: 'proxy', revision: snapshot.revision, elapsedMs: 30, password: 'fixture-secret', url: 'wss://fixture-ticket' }
    try {
      recordEvent('outbound.console', 'warn', 'outbound', { ...metadata, code: 'authentication' })
      await vi.waitFor(async () => expect((await status(actor)).hetznerConsole.lastFailure?.category).toBe('authentication'))
      recordEvent('outbound.console', 'info', 'outbound', { ...metadata, code: 'none', elapsedMs: 21 })
      await vi.waitFor(async () => {
        const result = (await status(actor)).hetznerConsole
        expect(result.latest).toMatchObject({ route: 'proxy', category: 'none', latencyMs: 21 })
        expect(result.lastFailure).toMatchObject({ route: 'proxy', category: 'authentication', latencyMs: 30 })
        expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-ticket/)
      })
    } finally { await ctx.db.delete(systemEvents).where(eq(systemEvents.event, 'outbound.console')) }
  })
})
