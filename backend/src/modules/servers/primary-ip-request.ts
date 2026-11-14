import { and, eq } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { providerOperations, servers, users } from '../../db/schema.js'
import { ConflictError, InsufficientFundsError, NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import type { SessionUser } from '../auth/service.js'
import { assertPowerOnFunding, serverPowerPolicy, type FundingFleet } from '../billing/funding.js'
import { isSiteAuthority } from '../integration/authority.js'
import type { ProviderServerView } from '../providers/provider.interface.js'
import { debitWallet } from '../wallets/service.js'
import { customerProvider, findBlockingManagementOperation, managementBlock, managementConflict } from './management.js'
import { lockPrimaryIpv4Fee, primaryIpv4Fee } from './primary-ip-pricing.js'
import { getServerForUser } from './service.js'

export const replacePrimaryIpv4 = 'replace_primary_ipv4' as const
export type IpServer = typeof servers.$inferSelect
export type IpOperation = typeof providerOperations.$inferSelect
export interface IpRequest {
  actorId: string; walletId: string; providerServerId: string; oldIpId: number; oldIp: string;
  location: string; wasRunning: boolean; feeRial: number; version: string; ledgerId: string
}

async function billingWallet(db: DbOrTx, server: IpServer) {
  const order = await db.query.orders.findFirst({ where: t => and(eq(t.id, server.orderId), eq(t.userId, server.userId)) })
  if (!order) return undefined
  return db.query.wallets.findFirst({ where: t => and(eq(t.userId, server.userId), order.walletId ? eq(t.id, order.walletId) : eq(t.isDefault, true)) })
}

export async function ipv4Baseline(server: IpServer, view: ProviderServerView) {
  const provider = customerProvider(server).primaryIpv4
  const id = view.metadata?.primaryIpv4Id, location = view.metadata?.location
  if (!provider || view.providerServerId !== server.providerServerId || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
    typeof location !== 'string' || location !== server.providerLocation || (view.state !== 'active' && view.state !== 'suspended')) return null
  const old = await provider.read(server.providerServerId!, id)
  if (!old || old.serverId !== server.providerServerId!.split(':')[1] || old.address !== view.ipv4 || old.location !== location ||
    !old.autoDelete || old.protected || old.blocked || old.customReverseDns) return null
  return { oldIpId: old.id, oldIp: old.address, location, wasRunning: view.state === 'active' }
}

export async function quotePrimaryIpv4(db: DbClient, server: IpServer, view: ProviderServerView | null, blocked: boolean, fleet: FundingFleet) {
  const supported = isSiteAuthority() && server.provider === 'hetzner'
  const [price, wallet] = await Promise.all([primaryIpv4Fee(db, server.provider), supported ? billingWallet(db, server) : undefined])
  const baseline = supported && !blocked && view ? await ipv4Baseline(server, view).catch(() => null) : null
  const restartReserve = baseline?.wasRunning ? (serverPowerPolicy(server, fleet).requiredBalanceToman ?? 0) * 10 : 0
  const needsTopUp = supported && (!wallet || wallet.balanceRial < price.feeRial + restartReserve)
  const reason = !supported ? 'تعویض IPv4 اصلی در این ارائه‌دهنده پشتیبانی نمی‌شود.'
    : blocked ? 'ابتدا وضعیت سرور یا عملیات قبلی را بررسی کنید.'
      : !baseline ? 'آدرس IPv4 اصلی باید در همین پروژه متصل، قابل آزادسازی و بدون حفاظت حذف یا DNS معکوس سفارشی باشد.'
        : needsTopUp ? 'موجودی کیف پول برای هزینهٔ تعویض و اعتبار لازم جهت روشن‌ماندن سرور کافی نیست.' : null
  return { ...price, currentIp: blocked ? server.ipv4 : view?.ipv4 ?? server.ipv4, balanceRial: wallet?.balanceRial ?? 0,
    reason, needsTopUp }
}

export async function requestPrimaryIpv4(db: DbClient, user: SessionUser, serverId: string,
  input: { hostname: string; feeRial: number; version: string; currentIp: string }, key: string) {
  const existingServer = await getServerForUser(db, user.id, serverId)
  const businessKey = `replace-primary-ipv4:${user.id}:${key}`
  function replay(previous: IpOperation) {
    const accepted = previous.requestMetadata as IpRequest
    if (previous.referenceId !== serverId || accepted.feeRial !== input.feeRial || accepted.version !== input.version || accepted.oldIp !== input.currentIp) {
      throw new ConflictError('این کلید برای درخواست دیگری استفاده شده است')
    }
    return previous
  }
  const previous = await db.query.providerOperations.findFirst({ where: t => eq(t.businessKey, businessKey) })
  if (previous) return replay(previous)
  if (!isSiteAuthority() || existingServer.provider !== 'hetzner') throw new ConflictError('تعویض IPv4 برای این ارائه‌دهنده در دسترس نیست.')
  const currentPrice = await primaryIpv4Fee(db, existingServer.provider)
  if (currentPrice.feeRial !== input.feeRial || currentPrice.version !== input.version) throw new ConflictError('هزینه تغییر کرده است. قیمت جدید را بررسی کنید.')
  const manager = customerProvider(existingServer)
  if (!manager.primaryIpv4) throw new ConflictError('تعویض IPv4 برای این سرور در دسترس نیست.')
  const baseline = await ipv4Baseline(existingServer, await manager.inspect(existingServer.providerServerId!))
  if (!baseline || baseline.oldIp !== input.currentIp) throw new ConflictError('آدرس فعلی یا مالکیت IPv4 قابل تأیید نیست. اطلاعات سرور را تازه کنید.')
  return db.transaction(async tx => {
    const [owner] = await tx.select().from(users).where(eq(users.id, user.id)).for('no key update')
    const [server] = await tx.select().from(servers).where(and(eq(servers.id, serverId), eq(servers.userId, user.id))).for('update')
    if (!server || owner?.status !== 'active' || server.providerServerId !== existingServer.providerServerId ||
      server.provider !== existingServer.provider || server.providerLocation !== baseline.location) throw new NotFoundError()
    const duplicate = await tx.query.providerOperations.findFirst({ where: t => eq(t.businessKey, businessKey) })
    if (duplicate) return replay(duplicate)
    const block = managementBlock(server, !!await findBlockingManagementOperation(tx, server.id))
    if (block) throw new ConflictError(managementConflict[block])
    if (server.hostname !== input.hostname) throw new ConflictError('نام سرور برای تأیید مطابقت ندارد.')
    await lockPrimaryIpv4Fee(tx, server.provider)
    const price = await primaryIpv4Fee(tx, server.provider)
    if (price.feeRial !== input.feeRial || price.version !== input.version) throw new ConflictError('هزینه تغییر کرده است. قیمت جدید را بررسی کنید.')
    const wallet = await billingWallet(tx, server)
    if (!wallet) throw new InsufficientFundsError('کیف پول پرداخت سرور موجودی کافی ندارد.')
    const [operation] = await tx.insert(providerOperations).values({ provider: server.provider, kind: 'server_management', action: replacePrimaryIpv4,
      referenceType: 'server', referenceId: server.id, businessKey, status: 'pending' }).returning()
    if (!operation) throw new Error('Could not record primary IPv4 replacement')
    const debit = await debitWallet(tx, user.id, wallet.id, price.feeRial, { referenceType: 'primary_ipv4_replacement', referenceId: server.id,
      idempotencyKey: `primary-ipv4:${operation.id}:reserve`, description: `تعویض IPv4 اصلی — ${server.hostname}`, metadata: { operationId: operation.id } })
    // Running hourly servers must retain enough balance for the normal restart policy.
    if (baseline.wasRunning) await assertPowerOnFunding(tx, server)
    const request: IpRequest = { ...baseline, ...price, actorId: user.id, walletId: wallet.id, providerServerId: server.providerServerId!, ledgerId: debit.transaction.id }
    const [accepted] = await tx.update(providerOperations).set({ requestMetadata: request }).where(eq(providerOperations.id, operation.id)).returning()
    await writeAudit(tx, { actorId: user.id, action: 'server.primary_ipv4.requested', targetType: 'server', targetId: server.id,
      metadata: { operationId: operation.id, feeRial: request.feeRial, ledgerId: request.ledgerId } })
    return accepted!
  })
}
