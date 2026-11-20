import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getConfig } from '../../config.js'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { settings } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { createLogger } from '../../logger.js'
import { publishNotification } from '../notifications/service.js'
import { outboundFetch } from '../outbound/client.js'
import { errorCategory } from '../outbound/policy.js'
import { recordEvent } from '../system/events.js'
import { saveFxRate } from './rate-history.js'

export type FxRate = { rate: string; from: string; to: string; createdAt: Date; id?: number; source?: string }
const markets = ['EUR', 'USDT'] as const
type Market = typeof markets[number]
const sources = {
  EUR: 'AbanTether EURIRT buy_price (toman × 10)',
  USDT: 'AbanTether USDTIRT buy_price (toman × 10); USD = USDT',
} as const
export const euroMarketSource = sources.EUR
export const euroRefreshIntervalMs = 30 * 60_000
export const fxMaxAgeMs = (currency: string) => (currency === 'USD' || currency === 'USDT' ? getConfig().USDT_RATE_MAX_AGE_SECONDS : 86400) * 1000
export const usdtRefreshIntervalMs = () => Math.min(euroRefreshIntervalMs, Math.max(500, Math.floor(fxMaxAgeMs('USDT') / 2)))
const inFlight = new WeakMap<DbClient, Map<Market, Promise<FxRate>>>()
const logger = createLogger('pricing')
const stateKey = (market: Market) => `pricing.market_fx.${market}`
const leaseMs = 18_000
type State = { owner?: string; leaseUntil?: number; retryAt?: number; failures?: number; failure?: string; alert?: 'warning' | 'error' }

const unavailable = (market: Market) => new AppError(503, market === 'EUR' ? 'eur_rate_unavailable' : 'usdt_rate_unavailable',
  market === 'EUR' ? 'قیمت یورویی موقتاً در دسترس نیست. برای دریافت نرخ تازه دوباره تلاش کنید.' : 'قیمت دلاری موقتاً در دسترس نیست. برای دریافت نرخ تازهٔ تتر دوباره تلاش کنید.')

class MarketFailure extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly httpStatus?: number) { super(code) }
}

async function fetchTicker(market: Market) {
  const url = new URL('/api/v1/manager/otc/ticker', getConfig().USDT_RATE_API_BASE_URL)
  url.searchParams.set('coin', market)
  const signal = AbortSignal.timeout(5_000)
  let response: Response
  try { response = await outboundFetch('abantether', url, { headers: { accept: 'application/json' }, cache: 'no-store', signal }) }
  catch (error) {
    const code = errorCategory(error)
    throw new MarketFailure(code, ['timeout', 'dns', 'unreachable'].includes(code))
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new MarketFailure('http_error', response.status === 429 || response.status >= 500, response.status)
  }
  const schema = z.object({ data: z.object({ markets: z.object({ [market + 'IRT']: z.object({
    symbol: z.literal(market), active: z.literal(true), buy_price: z.string().max(32).regex(/^\d+(?:\.\d{1,8})?$/),
  }) }) }) })
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new MarketFailure(signal.aborted ? 'timeout' : 'invalid_ticker', signal.aborted)
  const [whole, fraction = ''] = parsed.data.data.markets[market + 'IRT']!.buy_price.split('.')
  const tomanScaled = BigInt(whole!) * 100000000n + BigInt(fraction.padEnd(8, '0'))
  const rialMicros = (tomanScaled + 9n) / 10n
  if (rialMicros <= 0n || rialMicros >= 100000000000000000000n) throw new MarketFailure('invalid_rate')
  return `${rialMicros / 1000000n}.${(rialMicros % 1000000n).toString().padStart(6, '0')}`
}

async function observeTicker(market: Market) {
  try { return await fetchTicker(market) }
  catch (error) {
    if (!(error instanceof MarketFailure) || !error.retryable) throw error
    await delay(500)
    return fetchTicker(market)
  }
}

function latestMarket(db: DbOrTx, market: Market) {
  return db.query.fxRates.findFirst({
    where: t => and(eq(t.fromCurrency, market), eq(t.toCurrency, 'IRR'), isNull(t.setBy), eq(t.note, sources[market]), lte(t.createdAt, new Date())),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
  })
}
const dto = (row: NonNullable<Awaited<ReturnType<typeof latestMarket>>>): FxRate =>
  ({ id: row.id, from: row.fromCurrency, to: row.toCurrency, rate: row.rate, createdAt: row.createdAt, source: row.note! })
async function readState(db: DbOrTx, market: Market): Promise<State> {
  return (await db.query.settings.findFirst({ where: t => eq(t.key, stateKey(market)) }))?.value as State | undefined ?? {}
}
function lockState(db: DbOrTx, market: Market) {
  return db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${stateKey(market)},0))`)
}
async function saveState(db: DbOrTx, market: Market, value: State) {
  await db.insert(settings).values({ key: stateKey(market), value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

function rateHealth(market: Market, last: Awaited<ReturnType<typeof latestMarket>>) {
  if (!last) return 'missing'
  const remaining = last.createdAt.getTime() + fxMaxAgeMs(market) - Date.now()
  if (remaining <= 0) return 'expired'
  return remaining <= Math.min(2 * euroRefreshIntervalMs, fxMaxAgeMs(market) / 4) ? 'expiring' : 'fresh'
}

async function markFailure(db: DbClient, market: Market, owner: string, failure: MarketFailure) {
  await db.transaction(async tx => {
    await lockState(tx, market)
    const state = await readState(tx, market)
    if (state.owner !== owner) return
    const last = await latestMarket(tx, market)
    const health = rateHealth(market, last)
    const failures = (state.failures ?? 0) + 1
    const alert = health === 'expired' || health === 'missing' ? 'error' : health === 'expiring' || failures >= 3 ? 'warning' : undefined
    await saveState(tx, market, { failures, failure: failure.code, retryAt: Date.now() + 2_000, alert })
    if (!alert || alert === state.alert) return
    const admins = await tx.query.users.findMany({ columns: { id: true }, where: t => and(eq(t.role, 'super_admin'), eq(t.status, 'active')) })
    for (const admin of admins) await publishNotification(tx, { userId: admin.id, eventKey: `pricing-fx:${market}:${owner}`, type: alert,
      title: `اختلال نرخ ${market} آبان‌تتر`, body: 'سلامت نرخ، آخرین ثبت موفق و علت خطا را در عملیات مالی بررسی کنید.', href: '/admin/settings/finance' })
  })
}

async function refresh(db: DbClient, market: Market): Promise<FxRate> {
  const owner = randomUUID()
  const deadline = Date.now() + leaseMs + 2_000
  // The cross-process lease is committed before HTTP. No DB transaction or connection waits on the provider.
  while (Date.now() < deadline) {
    const claim = await db.transaction(async tx => {
      await lockState(tx, market)
      const row = await latestMarket(tx, market)
      if (row && Date.now() - row.createdAt.getTime() < Math.min(60_000, fxMaxAgeMs(market) / 2)) return { row }
      const state = await readState(tx, market)
      if ((state.retryAt ?? 0) > Date.now()) throw unavailable(market)
      if ((state.leaseUntil ?? 0) > Date.now()) return null
      await saveState(tx, market, { ...state, owner, leaseUntil: Date.now() + leaseMs })
      return { row: null }
    })
    if (claim?.row) return dto(claim.row)
    if (claim) break
    await delay(650)
  }
  if (Date.now() >= deadline) throw unavailable(market)
  try {
    const rate = await observeTicker(market)
    return await db.transaction(async tx => {
      await lockState(tx, market)
      if ((await readState(tx, market)).owner !== owner) throw new MarketFailure('refresh_lease_expired')
      const saved = await saveFxRate(tx, rate, { currency: market, source: 'market', note: sources[market] })
      await saveState(tx, market, {})
      return dto(saved)
    })
  } catch (error) {
    const failure = error instanceof MarketFailure ? error : new MarketFailure('db_write')
    const event = market === 'EUR' ? 'pricing.eur_refresh_failed' : 'pricing.usdt_refresh_failed'
    const fields = { integration: 'abantether', code: failure.code, httpStatus: failure.httpStatus }
    recordEvent(event, 'error', 'pricing', fields)
    logger.warn({ event, ...fields }, 'Market FX refresh failed')
    await markFailure(db, market, owner, failure).catch(() => logger.warn({ event, code: 'db_write' }, 'Market FX health could not be updated'))
    throw unavailable(market)
  }
}

export function refreshMarketRate(db: DbClient, market: Market): Promise<FxRate> {
  let active = inFlight.get(db)
  if (!active) { active = new Map(); inFlight.set(db, active) }
  const pending = active.get(market)
  if (pending) return pending
  const next = refresh(db, market).finally(() => active.delete(market))
  active.set(market, next)
  return next
}
export const refreshEuroRate = (db: DbClient) => refreshMarketRate(db, 'EUR')

export async function getMarketRate(db: DbClient, market: Market) {
  const row = await latestMarket(db, market)
  return row && Date.now() < row.createdAt.getTime() + fxMaxAgeMs(market) ? dto(row) : refreshMarketRate(db, market)
}

export async function readMarketFxHealth(db: DbClient) {
  return Promise.all(markets.map(async market => {
    const last = await latestMarket(db, market)
    const state = await readState(db, market)
    return { market, health: rateHealth(market, last), rate: last?.rate ?? null, source: sources[market],
      lastSuccessAt: last?.createdAt.toISOString() ?? null,
      validUntil: last ? new Date(last.createdAt.getTime() + fxMaxAgeMs(market)).toISOString() : null,
      failures: state.failures ?? 0, error: state.failure ?? null }
  }))
}
