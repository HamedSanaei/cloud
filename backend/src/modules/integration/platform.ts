import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, ne, notInArray } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { getConfig } from '../../config.js'
import { invoices, orders, platformLinks, providerOperations, servers, subscriptions, wallets } from '../../db/schema.js'
import type { DbClient } from '../../db/index.js'
import { requireUser } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { AppError, BadRequestError, ConflictError } from '../../lib/errors.js'

export function platformEnabled(): boolean { return Boolean(getConfig().PLATFORM_API_URL) }

const PLATFORM_CONTRACT_VERSION = '1'

/** Refuse a cutover that would hide existing balances/contracts or abandon work. */
export async function assertUnifiedCutoverReady(db: DbClient): Promise<void> {
  if (!platformEnabled()) return
  const residual = await Promise.all([
    db.select({ id: wallets.id }).from(wallets).where(ne(wallets.balanceRial, 0)).limit(1),
    db.select({ id: servers.id }).from(servers).where(notInArray(servers.status, ['terminated', 'failed'])).limit(1),
    db.select({ id: subscriptions.id }).from(subscriptions).where(notInArray(subscriptions.status, ['cancelled', 'expired'])).limit(1),
    db.select({ id: orders.id }).from(orders).where(notInArray(orders.status, ['cancelled', 'failed', 'refunded', 'active'])).limit(1),
    db.select({ id: invoices.id }).from(invoices).where(notInArray(invoices.status, ['paid', 'void', 'refunded'])).limit(1),
    db.select({ id: providerOperations.id }).from(providerOperations).where(notInArray(providerOperations.status, ['succeeded', 'failed'])).limit(1),
  ])
  if (residual.some(rows => rows.length > 0)) throw new Error('Unified cutover refused: reconcile legacy balances, contracts and pending work before enabling PLATFORM_API_URL. See docs/PLATFORM_INTEGRATION.md')
  await assertPlatformCompatibility()
}

function key(): Buffer { return createHash('sha256').update(getConfig().AUTH_SECRET + ':platform-link:v1').digest() }
export function encryptPlatformToken(token: string, userId: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(userId))
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}
export function decryptPlatformToken(encrypted: string, userId: string): string {
  const [iv, tag, data] = encrypted.split('.').map(b => Buffer.from(b, 'base64url'))
  if (!iv || !tag || !data) throw new Error('invalid platform token envelope')
  const cipher = createDecipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(userId))
  cipher.setAuthTag(tag)
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')
}

export async function platformRequest<T>(token: string, path: string, method = 'GET', body?: unknown, idempotencyKey?: string, timeoutMs = 45_000): Promise<T> {
  const config = getConfig()
  const base = new URL(config.PLATFORM_API_URL)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['https:', 'http:'].includes(base.protocol) || (config.NODE_ENV === 'production' && base.protocol !== 'https:' && !['127.0.0.1', 'localhost', 'cloud-platform-api'].includes(base.hostname))) {
    throw new AppError(503, 'platform_configuration', 'آدرس اتصال پلتفرم معتبر نیست')
  }
  try {
    const response = await fetch(base.toString().replace(/\/$/, '') + '/v1/console' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-platform-contract': PLATFORM_CONTRACT_VERSION, 'x-platform-environment': config.APP_ENV ?? config.NODE_ENV, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json() as { error?: { message?: string; code?: string } }
    if (!response.ok) throw new AppError(response.status, payload.error?.code ?? 'platform_error', payload.error?.message ?? 'عملیات پلتفرم تکمیل نشد')
    if (response.headers.get('x-platform-contract') !== PLATFORM_CONTRACT_VERSION) throw new AppError(503, 'platform_contract', 'نسخه قرارداد پلتفرم با سایت سازگار نیست')
    return payload as T
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(502, 'platform_unavailable', 'اتصال به پلتفرم مشترک برقرار نشد؛ وضعیت درخواست را پیش از تلاش مجدد بررسی کنید')
  }
}

export async function assertPlatformCompatibility(): Promise<void> {
  if (!platformEnabled()) return
  const config = getConfig()
  const [{ data }, readiness] = await Promise.all([
    platformRequest<{ data: { version: string; environment: string; walletCurrency: string; headerIdentityEnabled: boolean; usdUsdtParity: string; usdtSettlementEnabled: boolean; displayCurrency: string; confirmationSigningConfigured: boolean } }>('', '/link/contract', 'GET', undefined, undefined, 3_000),
    fetch(new URL('/health/ready', config.PLATFORM_API_URL), { redirect: 'error', signal: AbortSignal.timeout(3_000) }),
  ])
  if (!readiness.ok) throw new AppError(503, 'platform_unavailable', 'سرویس مرجع برای پردازش درخواست آماده نیست')
  if (data.version !== PLATFORM_CONTRACT_VERSION || data.environment !== (config.APP_ENV ?? config.NODE_ENV) || data.walletCurrency !== 'IRT' || data.displayCurrency !== 'IRT' || data.headerIdentityEnabled || data.usdUsdtParity !== '1' || !data.usdtSettlementEnabled || !data.confirmationSigningConfigured) {
    throw new AppError(503, 'platform_contract', 'محیط، واحد تومانی یا سیاست USD/USDT پلتفرم برای اتصال امن آماده نیست')
  }
}

function assertSafeFinancialInput(path: string, body: unknown): void {
  const field = path === '/recharge' || path.endsWith('/wallet-adjustments') ? 'amountMinor' : path === '/orders' ? 'expectedMinor' : undefined
  if (field && (!body || typeof body !== 'object' || !Number.isSafeInteger((body as Record<string, unknown>)[field]))) {
    throw new BadRequestError('مبلغ باید عدد صحیح در محدوده امن باشد')
  }
}

async function linkedToken(ctx: AppContext, request: FastifyRequest): Promise<string> {
  const user = requireUser(request)
  const link = await ctx.db.query.platformLinks.findFirst({ where: t => eq(t.userId, user.id) })
  if (!link) throw new AppError(409, 'platform_link_required', 'ابتدا حساب تلگرام را در بخش «پلتفرم مشترک» متصل کنید')
  return decryptPlatformToken(link.tokenEncrypted, user.id)
}

interface PlatformServer { server_id: string; state: string; display_name?: string; provider_key?: string; location_label?: string; ip?: string; operating_system?: string; cpu?: number; ram_gb?: number; storage_gb?: number }
export function serverProjection(s: PlatformServer) {
  return { id: s.server_id, name: s.display_name ?? s.provider_key ?? s.server_id.slice(0, 8), status: s.state === 'running' ? 'active' : s.state === 'stopped' ? 'inactive' : 'building', datacenter: s.location_label ?? s.provider_key ?? '', ip: s.ip, os: s.operating_system, cpu: `${s.cpu ?? '—'} vCPU`, ram: `${s.ram_gb ?? '—'} GB`, disk: `${s.storage_gb ?? '—'} GB`, power: { canPowerOn: false, canPowerOff: false, canReboot: false, billingBlocked: false, requiredBalanceToman: null, pendingAction: null } }
}

// Reject currency reinterpretation rather than display USD cents as toman.
export function requireToman(balance: { currency: string; balance_minor: number }): number {
  if (balance.currency !== 'IRT') throw new ConflictError('کیف پول مشترک هنوز به تومان منتقل نشده است؛ موجودی را در پلتفرم مشترک با واحد اصلی ببینید')
  if (!Number.isSafeInteger(balance.balance_minor)) throw new ConflictError('مبلغ خارج از محدوده نمایش است')
  return balance.balance_minor
}

export function installPlatformIntegration(app: FastifyInstance, ctx: AppContext): void {
  for (const prefix of ['/api', '/api/v1']) {
  app.get(prefix + '/integration/status', async request => {
    const user = requireUser(request)
    const link = await ctx.db.query.platformLinks.findFirst({ where: t => eq(t.userId, user.id) })
    return { data: { enabled: platformEnabled(), linked: Boolean(link), platformUserId: link?.platformUserId ?? null } }
  })
  app.post(prefix + '/integration/connect', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireUser(request)
    if (!platformEnabled()) throw new BadRequestError('PLATFORM_API_URL پیکربندی نشده است')
    const input = parse(z.object({ code: z.string().regex(/^cpl_[A-Za-z0-9_-]{43}$/) }).strict(), request.body)
    const account = await platformRequest<{ data: { id: string; token: string } }>('', '/link/exchange', 'POST', { code: input.code, websiteUserId: user.id })
    const existing = await ctx.db.query.platformLinks.findFirst({ where: t => eq(t.userId, user.id) })
    if (existing && existing.platformUserId !== account.data.id) throw new ConflictError('تغییر هویت متصل نیازمند بررسی انتقال دارایی است')
    const encrypted = encryptPlatformToken(account.data.token, user.id)
    const saved = await ctx.db.insert(platformLinks).values({ userId: user.id, platformUserId: account.data.id, tokenEncrypted: encrypted }).onConflictDoUpdate({ target: platformLinks.userId, set: { tokenEncrypted: encrypted }, setWhere: eq(platformLinks.platformUserId, account.data.id) }).returning({ userId: platformLinks.userId })
    if (!saved.length) throw new ConflictError('حساب دیگری هم‌زمان متصل شده است؛ تغییر هویت متصل مجاز نیست')
    reply.header('Cache-Control', 'no-store')
    return { data: { linked: true, platformUserId: account.data.id } }
  })
  }

  // Runs AFTER session/CSRF validation. In unified mode no legacy money/compute write can fall through.
  app.addHook('preHandler', async (request, reply) => {
    if (!platformEnabled()) return
    let pathname: string
    try { pathname = decodeURIComponent(request.url.split('?')[0]!).replace(/^\/api\/v1(?=\/)/, '/api') } catch { throw new BadRequestError('مسیر نامعتبر است') }
    if (pathname.startsWith('/api/platform/')) {
      const path = pathname.slice('/api/platform'.length)
      const allowed = /^\/(account|wallet|notifications|offers|servers|recharge(?:\/gateways)?|orders|admin\/users|admin\/test-server\/register)$|^\/admin\/users\/[a-f0-9-]{36}\/wallet-adjustments$|^\/offers\/[a-f0-9-]{36}\/images$|^\/servers\/[a-f0-9-]{36}(?:\/(?:images|operations)|\/(?:actions|confirmations)\/[a-z-]+|\/credentials\/(?:claim|ack))?$/
      if (!allowed.test(path)) throw new BadRequestError('مسیر پلتفرم معتبر نیست')
      const token = await linkedToken(ctx, request)
      const supplied = request.headers['idempotency-key']
      if (request.method !== 'GET' && (typeof supplied !== 'string' || supplied.length < 8 || supplied.length > 128)) throw new BadRequestError('کلید یکتای درخواست الزامی است')
      if (request.method !== 'GET') assertSafeFinancialInput(path, request.body)
      const data = await platformRequest(token, path, request.method, request.body, typeof supplied === 'string' ? supplied : undefined)
      reply.header('Cache-Control', 'no-store')
      return reply.send(data)
    }
    const economic = /^\/api\/(wallets|servers|catalog|quotes|orders|subscriptions|invoices|charge-requests|dashboard|notifications|admin)(\/|$)/.test(pathname)
    if (!economic) return
    const token = await linkedToken(ctx, request)
    if (request.method !== 'GET') throw new ConflictError('این عملیات را در بخش «پلتفرم مشترک» انجام دهید؛ دفترکل قدیمی غیرفعال است')
    if (pathname === '/api/servers') {
      const data = await platformRequest<{ data: PlatformServer[] }>(token, '/servers')
      return reply.send({ data: data.data.map(serverProjection) })
    }
    if (['/api/wallets', '/api/wallets/summary', '/api/wallets/transactions'].includes(pathname)) {
      const { data } = await platformRequest<{ data: { balance: { balance_minor: number; currency: string }; history: { items: Array<{ entry_id: string; amount_minor: number; currency: string; description: string; entry_type: string; created_at: string }> } } }>(token, '/wallet')
      const amount = requireToman(data.balance)
      if (pathname.endsWith('/summary')) return reply.send({ data: { totalBalance: amount, wallets: 1, defaultWallet: 'مشترک تلگرام و سایت', connectedProducts: 0 } })
      if (pathname.endsWith('/transactions')) return reply.send({ data: data.history.items.map(item => ({ id: item.entry_id, amount: requireToman({ currency: item.currency, balance_minor: item.amount_minor }), description: item.description, type: item.entry_type, date: item.created_at, status: 'success' })) })
      return reply.send({ data: [{ id: 'platform', name: 'مشترک تلگرام و سایت', balance: amount, isDefault: true }] })
    }
    if (pathname === '/api/notifications') {
      const { data } = await platformRequest<{ data: Array<{ id: string; text: string; createdAt: string }> }>(token, '/notifications')
      return reply.send({ data: data.map(n => ({ id: n.id, title: n.text.split('\n')[0], body: n.text, type: 'info', read: false, createdAt: n.createdAt })) })
    }
    if (pathname === '/api/dashboard/summary') {
      const [{ data: fleet }, { data: wallet }] = await Promise.all([
        platformRequest<{ data: PlatformServer[] }>(token, '/servers'),
        platformRequest<{ data: { balance: { currency: string; balance_minor: number } } }>(token, '/wallet'),
      ])
      return reply.send({ data: { activeServers: fleet.filter(s => s.state === 'running').length, ips: fleet.filter(s => s.ip).length, domains: 0, trafficPackages: 0, openTickets: 0, unpaidInvoices: 0, walletBalance: requireToman(wallet.balance) } })
    }
    throw new ConflictError('این اطلاعات از بخش «پلتفرم مشترک» در دسترس است')
  })
  // Fastify resolves wildcard routes before preHandler; forwarding remains allowlisted above.
  app.all('/api/platform/*', async () => { throw new BadRequestError('اتصال پلتفرم فعال نیست') })
  app.all('/api/v1/platform/*', async () => { throw new BadRequestError('اتصال پلتفرم فعال نیست') })
}
