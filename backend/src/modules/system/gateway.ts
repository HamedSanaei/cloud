import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { gatewayCredentials, settings } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { ConflictError, ValidationError } from '../../lib/errors.js'
import { fingerprint, validToken } from '../payments/tabapay.js'
import type { SessionUser } from '../auth/service.js'
import { writeAudit } from '../audit/service.js'
import { consumeAuthorization, seal, unseal } from './security.js'

export interface GatewayConfig { enabled: boolean; sandbox: boolean; merchant: string; fingerprint: string; source: 'environment' | 'store' }
interface StoredConfig { enabled: boolean; sandbox: boolean; fingerprint: string }
export const gatewayLock = (tx: DbOrTx) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('system:gateway', 0))`)
export async function effectiveGateway(db: DbOrTx, wantedFingerprint?: string): Promise<GatewayConfig> {
  const c = getConfig()
  const row = await db.query.settings.findFirst({ where: t => eq(t.key, 'tabapay.active') })
  const stored = row?.value as StoredConfig | undefined
  const fp = wantedFingerprint ?? stored?.fingerprint ?? fingerprint()
  const secret = await db.query.gatewayCredentials.findFirst({ where: t => eq(t.fingerprint, fp) })
  const merchant = secret ? unseal(Buffer.from(secret.encrypted, 'base64'), `tabapay:${secret.id}`).toString() : fp === fingerprint() ? c.TABAPAY_MERCHANT : ''
  if (wantedFingerprint && !merchant) throw new ConflictError('نسخهٔ اعتبارنامهٔ این پرداخت در دسترس نیست؛ با پشتیبانی تماس بگیرید.')
  return { enabled: stored?.enabled ?? c.TABAPAY_ENABLED, sandbox: stored?.sandbox ?? c.TABAPAY_SANDBOX,
    merchant, fingerprint: fp, source: stored ? 'store' : 'environment' }
}
async function preserve(tx: DbOrTx, merchant: string, actorId: string) {
  if (!validToken(merchant)) return
  const fp = fingerprint(merchant)
  const previous = await tx.query.gatewayCredentials.findFirst({ where: t => eq(t.fingerprint, fp) })
  if (previous) return
  const id = randomUUID()
  await tx.insert(gatewayCredentials).values({ id, fingerprint: fp, encrypted: seal(Buffer.from(merchant), `tabapay:${id}`).toString('base64'), suffix: merchant.slice(-4), createdBy: actorId })
}
export async function gatewayStatus(db: DbClient) {
  const active = await effectiveGateway(db), c = getConfig()
  const versions = await db.select({ fingerprint: gatewayCredentials.fingerprint, suffix: gatewayCredentials.suffix, createdAt: gatewayCredentials.createdAt }).from(gatewayCredentials)
  const url = new URL(c.FRONTEND_URL)
  return { enabled: active.enabled, sandbox: active.sandbox, source: active.source, configured: validToken(active.merchant),
    maskedMerchant: active.merchant ? `••••${active.merchant.slice(-4)}` : '', fingerprint: active.fingerprint,
    domain: url.hostname, callbackUrl: new URL('/api/v1/payments/tabapay/callback', url).href,
    returnUrl: new URL('/wallet', url).href, versions }
}
export async function updateGateway(db: DbClient, user: SessionUser, input: { enabled: boolean; sandbox: boolean; merchant?: string; version?: string; confirm: true }, proof: string) {
  const c = getConfig()
  if ((c.NODE_ENV === 'production' || c.APP_ENV === 'staging') && (input.sandbox || new URL(c.FRONTEND_URL).protocol !== 'https:')) throw new ValidationError('در محیط عملیاتی، HTTPS الزامی و درگاه آزمایشی ممنوع است.')
  return db.transaction(async tx => {
    await consumeAuthorization(tx, user, proof, 'gateway.update', input)
    await gatewayLock(tx)
    const previous = await effectiveGateway(tx)
    const next = input.version ? await effectiveGateway(tx, input.version) : null
    const merchant = input.merchant ?? next?.merchant ?? previous.merchant
    if (!validToken(merchant)) throw new ValidationError('مرچنت باید یک UUID معتبر باشد.')
    await preserve(tx, previous.merchant, user.id); await preserve(tx, merchant, user.id)
    const value = { enabled: input.enabled, sandbox: input.sandbox, fingerprint: fingerprint(merchant) }
    await tx.insert(settings).values({ key: 'tabapay.active', value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    await writeAudit(tx, { actorId: user.id, action: 'system.gateway_updated', metadata: { enabled: input.enabled, sandbox: input.sandbox, previousSuffix: previous.merchant.slice(-4), suffix: merchant.slice(-4) } })
    return { updated: true }
  })
}
export async function diagnoseGateway(db: DbClient) {
  const cfg = await effectiveGateway(db)
  let reachable = false
  try { await fetch('https://api.tabapay.ir', { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5000) }); reachable = true } catch { /* No financial request, merchant or token sent. */ }
  return { reachable, credential: validToken(cfg.merchant) ? 'format_valid_provider_unverified' : 'invalid_format',
    domain: 'provider_confirmation_required', referer: 'browser_origin_required',
    message: 'این بررسی تراکنش نمی‌سازد. API مستندِ بدون تراکنش برای تأیید مرچنت یا دامنه وجود ندارد؛ تأیید دامنه باید در پنل تاباپی بررسی شود. لینک پرداخت Origin را ارسال می‌کند؛ افزونهٔ حریم خصوصی یا تنظیم مرورگر می‌تواند آن را حذف کند.' }
}
