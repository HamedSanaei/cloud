import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { notifications, orders, providerOperations, servers, subscriptions, users, wallets } from '../../db/schema.js'
import { InsufficientFundsError } from '../../lib/errors.js'
import { addInterval } from '../subscriptions/service.js'

type ServerRecord = typeof servers.$inferSelect
type SubscriptionRecord = typeof subscriptions.$inferSelect
type OperationRecord = typeof providerOperations.$inferSelect

export interface HourlyMember {
  server: ServerRecord
  subscription: SubscriptionRecord
  starting: boolean
}

export interface FundingGroup {
  walletId: string | null
  balanceRial: number
  members: HourlyMember[]
  runningCostRial: number
  activeCostRial: number
}

export interface FundingFleet {
  groups: FundingGroup[]
  operations: OperationRecord[]
  prepaid: Array<{ server: ServerRecord; subscription: SubscriptionRecord; walletId: string | null; balanceRial: number }>
}

export interface ServerPowerPolicy {
  canPowerOn: boolean
  canPowerOff: boolean
  canReboot: boolean
  billingBlocked: boolean
  requiredBalanceToman: number | null
  pendingAction: 'power_on' | 'power_off' | 'reboot' | null
}

function renewable(subscription: SubscriptionRecord): boolean {
  return subscription.status === 'active' || subscription.status === 'grace' || subscription.status === 'suspended'
}

/** Use the order's wallet, never the user's unrelated wallets or a paginated server list. */
export async function loadFundingFleet(db: DbOrTx, userId: string, lockWallets = false): Promise<FundingFleet> {
  const walletQuery = db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(wallets.id)
  const ownedWallets = await (lockWallets ? walletQuery.for('update') : walletQuery)
  const ownedServers = await db.query.servers.findMany({ where: (t) => eq(t.userId, userId) })
  const operations = ownedServers.length ? await db.query.providerOperations.findMany({
    where: (t) => and(eq(t.kind, 'server_action'), inArray(t.referenceId, ownedServers.map((server) => server.id)), inArray(t.status, ['pending', 'running', 'unknown'])),
  }) : []
  const billable = await db.select({ server: servers, subscription: subscriptions, walletId: orders.walletId })
    .from(servers)
    .innerJoin(subscriptions, eq(servers.subscriptionId, subscriptions.id))
    .innerJoin(orders, eq(servers.orderId, orders.id))
    .where(and(eq(servers.userId, userId), inArray(servers.status, ['active', 'suspended'])))
  const fallback = ownedWallets.find((wallet) => wallet.isDefault)
  const groups = new Map<string, FundingGroup>()
  const prepaid: FundingFleet['prepaid'] = []
  for (const row of billable) {
    const walletId = row.walletId ?? fallback?.id ?? null
    const wallet = ownedWallets.find((item) => item.id === walletId)
    if (row.subscription.billingInterval !== 'HOURLY') {
      prepaid.push({ ...row, walletId, balanceRial: wallet?.balanceRial ?? 0 })
      continue
    }
    const key = walletId ?? 'missing'
    let group = groups.get(key)
    if (!group) {
      group = { walletId, balanceRial: wallet?.balanceRial ?? 0, members: [], runningCostRial: 0, activeCostRial: 0 }
      groups.set(key, group)
    }
    const starting = operations.some((operation) => operation.referenceId === row.server.id && operation.action === 'power_on')
    group.members.push({ server: row.server, subscription: row.subscription, starting })
    if (renewable(row.subscription)) {
      if (row.server.status === 'active' || starting) group.runningCostRial += row.subscription.priceRial
      if (row.server.status === 'active') group.activeCostRial += row.subscription.priceRial
    }
  }
  return { groups: [...groups.values()], operations, prepaid }
}

function fundingFor(fleet: FundingFleet, serverId: string) {
  for (const group of fleet.groups) {
    const member = group.members.find((item) => item.server.id === serverId)
    if (!member) continue
    const requiredRial = group.runningCostRial + (member.server.status === 'active' || member.starting ? 0 : member.subscription.priceRial)
    return { group, member, requiredRial, sufficient: renewable(member.subscription) && member.subscription.priceRial > 0 && group.balanceRial >= requiredRial }
  }
  return null
}

export function serverPowerPolicy(server: ServerRecord, fleet: FundingFleet): ServerPowerPolicy {
  const operation = fleet.operations.find((item) => item.referenceId === server.id)
  const pendingAction = operation?.action === 'power_on' || operation?.action === 'power_off' || operation?.action === 'reboot' ? operation.action : null
  const funding = fundingFor(fleet, server.id)
  const sufficient = !funding || funding.sufficient
  const ready = !!server.providerServerId && !pendingAction
  return {
    canPowerOn: ready && server.status === 'suspended' && sufficient,
    canPowerOff: ready && server.status === 'active',
    canReboot: ready && server.status === 'active' && sufficient,
    billingBlocked: !!funding && !funding.sufficient,
    requiredBalanceToman: funding ? Math.ceil(funding.requiredRial / 10) : null,
    pendingAction,
  }
}

/** Also called by the worker: funds may have changed after the API queued a start. */
export async function assertPowerOnFunding(db: DbOrTx, server: ServerRecord): Promise<void> {
  const funding = fundingFor(await loadFundingFleet(db, server.userId), server.id)
  if (funding && !funding.sufficient) {
    throw new InsufficientFundsError(`موجودی کیف پول پرداخت برای یک ساعت آینده کافی نیست. حداقل موجودی لازم: ${Math.ceil(funding.requiredRial / 10).toLocaleString('fa-IR')} تومان.`)
  }
}

/** The caller holds the user lock and commits the warning with its cooldown. */
export async function warnLowBalance(db: DbOrTx, userId: string, fleet: FundingFleet, now: Date): Promise<boolean> {
  const cooldown = new Date(now.getTime() - 6 * 60 * 60 * 1000)
  const user = await db.query.users.findFirst({ where: (t) => eq(t.id, userId), columns: { lowBalanceWarnedAt: true } })
  if (!user || (user.lowBalanceWarnedAt && user.lowBalanceWarnedAt > cooldown)) return false
  const endangered = forecastFunding(fleet, now)
  if (!endangered.length) return false
  const [claimed] = await db.update(users).set({ lowBalanceWarnedAt: now }).where(and(
    eq(users.id, userId),
    or(isNull(users.lowBalanceWarnedAt), lte(users.lowBalanceWarnedAt, cooldown)),
  )).returning({ id: users.id })
  if (!claimed) return false
  const minutes = Math.floor(Math.min(...endangered.map((group) => group.shortageAt - now.getTime())) / 60000)
  const topUpToman = Math.ceil(endangered.reduce((sum, group) => sum + group.topUpRial, 0) / 10)
  const names = endangered.flatMap((group) => group.names)
  await db.insert(notifications).values({
    userId,
    title: 'هشدار کمبود موجودی و خطر حذف سرور',
    body: `اعتبار کیف پول پرداخت سرورهای ${names.join('، ')} برای ۳ روز آینده کافی نیست (شروع کمبود اعتبار حدود ${Math.floor(minutes / 60).toLocaleString('fa-IR')} ساعت و ${(minutes % 60).toLocaleString('fa-IR')} دقیقه دیگر). اگر موجودی برای یک ساعت آینده کافی نباشد، سرورهای ساعتی خاموش می‌شوند؛ سایر پلن‌ها طبق سررسید و مهلت پرداخت تعلیق می‌شوند. ادامه کمبود اعتبار، خطر حذف سرور را دارد. برای تأمین ۳ روز، کیف پول‌های پرداخت مربوط را در مجموع حداقل ${topUpToman.toLocaleString('fa-IR')} تومان افزایش دهید. این هشدار تا رفع کمبود، هر ۶ ساعت تکرار می‌شود.`,
    type: 'warning',
  })
  return true
}

/** Replay actual renewal dates, including prepaid days/months and the hourly safety reserve. */
function forecastFunding(fleet: FundingFleet, now: Date) {
  const horizon = now.getTime() + 72 * 60 * 60 * 1000
  const wallets = new Map<string, { balanceRial: number; reserveRial: number; members: Array<{ server: ServerRecord; subscription: SubscriptionRecord }> }>()
  for (const group of fleet.groups) {
    wallets.set(group.walletId ?? 'missing', { balanceRial: group.balanceRial, reserveRial: group.activeCostRial, members: [...group.members] })
  }
  for (const member of fleet.prepaid) {
    const key = member.walletId ?? 'missing'
    let wallet = wallets.get(key)
    if (!wallet) {
      wallet = { balanceRial: member.balanceRial, reserveRial: 0, members: [] }
      wallets.set(key, wallet)
    }
    wallet.members.push(member)
  }
  const endangered: Array<{ shortageAt: number; topUpRial: number; names: string[] }> = []
  for (const wallet of wallets.values()) {
    const active = wallet.members.filter((member) => member.server.status === 'active' && renewable(member.subscription))
    const events: Array<{ at: number; priceRial: number }> = []
    let requiredRial = wallet.reserveRial
    for (const member of active) {
      let at = Math.max(member.subscription.nextInvoiceAt.getTime(), now.getTime())
      while (at < horizon) {
        events.push({ at, priceRial: member.subscription.priceRial })
        requiredRial += member.subscription.priceRial
        at = addInterval(new Date(at), member.subscription.billingInterval).getTime()
      }
    }
    if (wallet.balanceRial >= requiredRial) continue
    events.sort((left, right) => left.at - right.at)
    let remaining = wallet.balanceRial
    let shortageAt = remaining < wallet.reserveRial ? now.getTime() : horizon
    for (const event of events) {
      remaining -= event.priceRial
      if (remaining < wallet.reserveRial) { shortageAt = Math.min(shortageAt, event.at); break }
    }
    if (shortageAt < horizon) endangered.push({ shortageAt, topUpRial: requiredRial - wallet.balanceRial, names: active.map((member) => member.server.hostname) })
  }
  return endangered
}
