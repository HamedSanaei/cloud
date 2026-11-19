import { isSuperAdmin } from '../../contracts/account-role.js'
import { hkdfSync, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DbClient, DbOrTx } from '../../db/index.js'
import type { systemEvents } from '../../db/schema.js'
import { settings } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js'
import type { SessionUser } from '../auth/service.js'
import { consumeAuthorization, seal, unseal } from '../system/security.js'
import { writeAudit } from '../audit/service.js'
import { outboundIntegrations, type OutboundConsoleHealth, type OutboundState, type OutboundStatus, type OutboundTestResult } from '../../contracts/outbound.js'
import { emptyOutboundState, OutboundHttp, selectedRoute, OutboundFailure } from './client.js'
import { OutboundError, publicAddresses, testTargets, withinDeadline } from './policy.js'

export const outboundKey = 'network.outbound.v1'
const healthKey = 'network.outbound.health.v1'
const revision = z.union([z.literal('initial'), z.uuid()])
export const integrationSchema = z.enum(outboundIntegrations)
const host = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9:.-]+$/)
export const profileInput = z.object({ revision, id: z.uuid().optional(), name: z.string().trim().min(1).max(80),
  type: z.enum(['socks5', 'http', 'https']), host, port: z.number().int().min(1).max(65535), enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(30000), username: z.string().max(255).regex(/^[^:\r\n\0]*$/).optional(),
  password: z.string().max(255).regex(/^[^\r\n\0]*$/).optional(), clearCredentials: z.boolean().optional(), confirm: z.literal(true),
}).strict().refine(v => !v.clearCredentials || v.username === undefined && v.password === undefined, 'Credential edit is ambiguous')
export const routeInput = z.object({ revision, integration: integrationSchema, enabled: z.boolean(), profileId: z.uuid().nullable(),
  failurePolicy: z.enum(['closed', 'read-only-direct']), confirm: z.literal(true),
}).strict().refine(v => !v.enabled || !!v.profileId, 'An enabled route requires a proxy')
  .refine(v => v.integration !== 'hetzner' || v.failurePolicy === 'closed', 'Hetzner routing requires fail-closed behavior')
  .refine(v => v.integration !== 'abantether' || !v.enabled && v.profileId === null, 'آبان‌تتر فقط با اتصال مستقیم در دسترس است.')
export const deleteInput = z.object({ revision, id: z.uuid(), confirm: z.literal(true) }).strict()
export const testInput = z.object({ revision, integration: integrationSchema, profileId: z.uuid().optional(), confirm: z.literal(true) }).strict()
  .refine(v => v.integration !== 'abantether' || !v.profileId, 'آزمون آبان‌تتر فقط مستقیم انجام می‌شود.')
export const canManageOutbound = (user: SessionUser) => isSuperAdmin(user)
export function requireOutboundAdmin(user: SessionUser) {
  if (!canManageOutbound(user)) throw new ForbiddenError('تنظیمات شبکه فقط برای مدیر فعال پنل در دسترس است.')
}
// Reuse the application's existing secret with a separate purpose-specific key.
// No proxy-specific key or extra deployment configuration is required.
const encryptionKey = () => Buffer.from(hkdfSync('sha256', getConfig().AUTH_SECRET, 'parserver-outbound-v1', 'proxy-settings', 32))
export async function readOutbound(db: DbOrTx): Promise<OutboundState> {
  const row = await db.query.settings.findFirst({ where: t => eq(t.key, outboundKey) })
  if (!row) return emptyOutboundState()
  try {
    const stored = row.value as { revision: string; encrypted: string }
    const value = JSON.parse(unseal(Buffer.from(stored.encrypted, 'base64'), `${outboundKey}:${stored.revision}`, encryptionKey()).toString()) as OutboundState
    if (value.revision !== stored.revision || !Array.isArray(value.profiles) || !value.routes) throw new Error()
    if (value.routes.hetzner) value.routes.hetzner.failurePolicy = 'closed'
    if (value.routes.abantether) value.routes.abantether = { enabled: false, profileId: null, failurePolicy: 'closed' }
    return value
  } catch { throw new OutboundError('configuration') }
}
const lock = (tx: DbOrTx) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${outboundKey},0))`)
const assertRevision = (state: OutboundState, expected: string) => { if (state.revision !== expected) throw new ConflictError('تنظیمات شبکه تغییر کرده است؛ صفحه را تازه کنید.') }
async function store(tx: DbOrTx, state: OutboundState) {
  state.revision = randomUUID()
  const value = { revision: state.revision, encrypted: seal(Buffer.from(JSON.stringify(state)), `${outboundKey}:${state.revision}`, encryptionKey()).toString('base64') }
  await tx.insert(settings).values({ key: outboundKey, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
  return { revision: state.revision }
}
function consoleHealth(event?: typeof systemEvents.$inferSelect): OutboundConsoleHealth | null {
  if (!event?.metadata) return null
  const data = event.metadata as { route: OutboundConsoleHealth['route']; profileId?: string;
    revision: string; code: OutboundConsoleHealth['category']; elapsedMs: number }
  return { route: data.route, profileId: data.profileId ?? null, category: data.code, latencyMs: data.elapsedMs,
    checkedAt: event.createdAt.toISOString(), revision: data.revision }
}
export async function outboundStatus(db: DbClient): Promise<OutboundStatus> {
  const [state, storedHealth, latest, lastFailure] = await Promise.all([
    readOutbound(db),
    db.query.settings.findFirst({ where: t => eq(t.key, healthKey) }),
    db.query.systemEvents.findFirst({ where: (t, { eq }) => eq(t.event, 'outbound.console'), orderBy: (t, { desc }) => desc(t.createdAt) }),
    db.query.systemEvents.findFirst({ where: t => and(eq(t.event, 'outbound.console'), eq(t.level, 'warn')), orderBy: (t, { desc }) => desc(t.createdAt) }),
  ])
  const health = storedHealth?.value as Record<string, OutboundTestResult> | undefined
  return { revision: state.revision, profiles: state.profiles.map(({ username, password: _password, ...p }) => ({ ...p, authenticated: !!username, lastTest: health?.[`profile:${p.id}`] ?? null })),
    integrations: outboundIntegrations.map(id => ({ id, route: state.routes[id] ?? { enabled: false, profileId: null, failurePolicy: 'closed' },
      active: selectedRoute(state, id), lastTest: health?.[id] ?? null })),
    hetznerConsole: { latest: consoleHealth(latest), lastFailure: consoleHealth(lastFailure) } }
}
export async function saveProfile(db: DbClient, user: SessionUser, input: z.infer<typeof profileInput>, proof: string) {
  requireOutboundAdmin(user)
  // Validate proxy DNS before storing, but never connect or test arbitrary destinations.
  if (input.enabled) {
    try { await withinDeadline(publicAddresses(input.host), AbortSignal.timeout(5000)) } catch { throw new ValidationError('میزبان پراکسی باید به آدرس عمومی معتبر اشاره کند.') }
  }
  return db.transaction(async tx => {
    requireOutboundAdmin(user); await lock(tx)
    await consumeAuthorization(tx, user, proof, 'outbound.profile', input)
    const state = await readOutbound(tx); assertRevision(state, input.revision)
    const previous = input.id ? state.profiles.find(p => p.id === input.id) : undefined
    if (input.id && !previous) throw new NotFoundError()
    if (!previous && state.profiles.length >= 20) throw new ValidationError('حداکثر ۲۰ پراکسی قابل تعریف است.')
    const username = input.clearCredentials ? '' : input.username ?? previous?.username ?? ''
    const password = input.clearCredentials ? '' : input.password ?? previous?.password ?? ''
    if (!!username !== !!password || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) throw new ValidationError('نام کاربری و رمز پراکسی را با هم وارد کنید.')
    const profile = { id: previous?.id ?? randomUUID(), name: input.name, type: input.type, host: input.host, port: input.port,
      enabled: input.enabled, timeoutMs: input.timeoutMs, username, password }
    state.profiles = [...state.profiles.filter(p => p.id !== profile.id), profile]
    const result = await store(tx, state)
    await writeAudit(tx, { actorId: user.id, action: 'system.outbound_profile_saved', targetType: 'outbound_profile', targetId: profile.id,
      metadata: { enabled: profile.enabled, credentialChanged: input.clearCredentials || input.username !== undefined || input.password !== undefined, revision: result.revision } })
    return { ...result, id: profile.id }
  })
}
export async function saveRoute(db: DbClient, user: SessionUser, input: z.infer<typeof routeInput>, proof: string) {
  requireOutboundAdmin(user)
  return db.transaction(async tx => {
    requireOutboundAdmin(user); await lock(tx); await consumeAuthorization(tx, user, proof, 'outbound.route', input)
    const state = await readOutbound(tx); assertRevision(state, input.revision)
    if (input.profileId && !state.profiles.some(p => p.id === input.profileId && (!input.enabled || p.enabled))) throw new ValidationError('پراکسی انتخابی وجود ندارد یا فعال نیست.')
    state.routes[input.integration] = { enabled: input.enabled, profileId: input.profileId, failurePolicy: input.failurePolicy }
    const result = await store(tx, state)
    await writeAudit(tx, { actorId: user.id, action: 'system.outbound_route_saved', metadata: { integration: input.integration, enabled: input.enabled, profileId: input.profileId, failurePolicy: input.failurePolicy, revision: result.revision } })
    return result
  })
}
export async function deleteProfile(db: DbClient, user: SessionUser, input: z.infer<typeof deleteInput>, proof: string) {
  requireOutboundAdmin(user)
  return db.transaction(async tx => {
    requireOutboundAdmin(user); await lock(tx); await consumeAuthorization(tx, user, proof, 'outbound.delete', input)
    const state = await readOutbound(tx); assertRevision(state, input.revision)
    if (!state.profiles.some(p => p.id === input.id)) throw new NotFoundError()
    if (Object.values(state.routes).some(r => r.enabled && r.profileId === input.id)) throw new ConflictError('ابتدا مسیرهای وابسته را غیرفعال یا تغییر دهید.')
    state.profiles = state.profiles.filter(p => p.id !== input.id)
    for (const route of Object.values(state.routes)) if (route.profileId === input.id) route.profileId = null
    const result = await store(tx, state)
    const health = (await tx.query.settings.findFirst({ where: t => eq(t.key, healthKey) }))?.value as Record<string, OutboundTestResult> | undefined
    if (health) {
      delete health[`profile:${input.id}`]
      await tx.update(settings).set({ value: health }).where(eq(settings.key, healthKey))
    }
    await writeAudit(tx, { actorId: user.id, action: 'system.outbound_profile_deleted', targetType: 'outbound_profile', targetId: input.id })
    return result
  })
}
export async function testConnection(db: DbClient, user: SessionUser, input: z.infer<typeof testInput>, proof: string) {
  requireOutboundAdmin(user)
  const state = await db.transaction(async tx => {
    requireOutboundAdmin(user); await lock(tx); await consumeAuthorization(tx, user, proof, 'outbound.test', input)
    const state = await readOutbound(tx); assertRevision(state, input.revision)
    if (input.profileId && !state.profiles.some(p => p.id === input.profileId)) throw new NotFoundError()
    return state
  })
  const client = new OutboundHttp(async () => state), target = testTargets[input.integration], start = Date.now()
  const result: OutboundTestResult = { ...selectedRoute(state, input.integration), integration: input.integration, ok: false, reachable: false,
    category: 'unreachable', latencyMs: 0, testedAt: new Date().toISOString(), lastSuccessAt: null, revision: state.revision }
  if (input.profileId) { result.route = 'proxy'; result.profileId = input.profileId }
  try {
    const c = getConfig(), headers: Record<string, string> = {}
    // Profile tests prove transport only. Integration tests may also verify configured credentials.
    if (!input.profileId && input.integration === 'hetzner') {
      const token = c.PROVIDERS.hetzner.accounts.find(a => a.enabled && a.apiToken)?.apiToken
      if (token) headers.authorization = `Bearer ${token}`
    }
    if (!input.profileId && input.integration === 'leaseweb') {
      const key = c.PROVIDERS.leaseweb.accounts.find(a => a.enabled && a.apiKey)?.apiKey
      if (key) headers['X-LSW-Auth'] = key
    }
    const response = await client.request(input.integration, target.url, { method: target.method, headers }, input.profileId)
    Object.assign(result, response.report, { reachable: true, httpStatus: response.response.status })
    const authenticated = ![401, 403, 407].includes(response.response.status)
    result.ok = response.response.ok || !!input.profileId && [401, 403].includes(response.response.status)
    result.category = !authenticated ? 'authentication' : result.ok ? 'none' : 'upstream'
    await response.response.body?.cancel()
  } catch (error) {
    if (error instanceof OutboundFailure) Object.assign(result, error.route, { category: error.category })
  } finally { result.latencyMs = Date.now() - start; await client.close() }
  const key = input.profileId ? `profile:${input.profileId}` : input.integration
  await db.transaction(async tx => {
    await lock(tx)
    const health = ((await tx.query.settings.findFirst({ where: t => eq(t.key, healthKey) }))?.value ?? {}) as Record<string, OutboundTestResult>
    result.lastSuccessAt = result.ok ? result.testedAt : health[key]?.lastSuccessAt ?? null
    // Discard stale persisted status; the caller still gets the actual tested revision/route.
    if ((await readOutbound(tx)).revision === state.revision) {
      const value = { ...health, [key]: result }
      await tx.insert(settings).values({ key: healthKey, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    }
    await writeAudit(tx, { actorId: user.id, action: 'system.outbound_connection_tested', metadata: { integration: input.integration, profileId: result.profileId, route: result.route,
      result: result.category, success: result.ok, httpStatus: result.httpStatus, elapsedMs: result.latencyMs, revision: state.revision } })
  })
  return result
}
