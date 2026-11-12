/**
 * Admin console backed by the website PostgreSQL DB. Sales switches are the
 * only mutations here and are authorized, transactional and audited.
 * No provider credentials, password hashes, TOTP material or platform tokens
 * are returned. The canonical site-authority guard runs before these routes.
 */
import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { users, wallets, orders, servers, providers, tickets } from '../../db/schema.js'
import { ticketToDto } from '../../lib/dto.js'
import { getConfig } from '../../config.js'
import { syncHetznerInventory } from '../providers/hetzner/inventory.js'
import { requireAdmin } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { NotFoundError, ConflictError } from '../../lib/errors.js'
import { rialToToman } from '../../lib/money.js'
import { isSiteAuthority } from '../integration/authority.js'
import { writeAudit } from '../audit/service.js'
import { listProviders } from '../providers/registry.js'

const paging = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(''),
  status: z.string().trim().max(40).default(''),
})
const idParam = z.object({ id: z.string().uuid() })

function ensureSiteAuthority() {
  if (!isSiteAuthority()) throw new ConflictError('اطلاعات این پنل هنوز در سرویس مرجع است؛ انتقال امن داده‌ها به سایت باید تکمیل شود')
}
function userDto(u: typeof users.$inferSelect) {
  return {
    id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
    mobile: u.mobile, role: u.role, status: u.status,
    emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
    mobileVerifiedAt: u.mobileVerifiedAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }
}
function money(value: number) {
  if (!Number.isSafeInteger(value)) throw new ConflictError('مبلغ خارج از محدوده امن نمایش است')
  return { balanceRial: value, balanceToman: rialToToman(value) }
}
function serverDto(s: typeof servers.$inferSelect) {
  return {
    id: s.id, userId: s.userId, orderId: s.orderId, name: s.hostname,
    status: s.status, provider: s.provider, providerLocation: s.providerLocation,
    providerServerId: s.providerServerId, ipv4: s.ipv4, ipv6: s.ipv6,
    vcpu: s.vcpu, memoryMb: s.memoryMb, diskGb: s.diskGb,
    operatingSystem: s.operatingSystem, trafficLimitGb: s.trafficLimitGb,
    trafficUsedGb: s.trafficUsedGb,
    createdAt: s.createdAt.toISOString(),
    activatedAt: s.activatedAt?.toISOString() ?? null,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
  }
}
function orderDto(o: typeof orders.$inferSelect) {
  return {
    id: o.id, orderNumber: o.orderNumber, userId: o.userId,
    status: o.status, totalRial: o.totalRial, totalToman: rialToToman(o.totalRial),
    hostname: o.hostname, provider: o.provider,
    providerProductId: o.providerProductId, providerLocation: o.providerLocation,
    billingInterval: o.billingInterval, operatingSystem: o.operatingSystem,
    paidAt: o.paidAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(),
    error: o.error,
  }
}
function pageData<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, limit, pages: Math.ceil(total / limit) }
}
async function userNames(ctx: AppContext, ids: string[]) {
  const rows = ids.length ? await ctx.db.select({
    id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
  }).from(users).where(inArray(users.id, [...new Set(ids)])) : []
  return new Map(rows.map(u => [u.id, {
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    email: u.email,
  }]))
}

export const registerAdminConsoleRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  // Route-level auth + source guard: fail closed, never show stale legacy balances.
  app.addHook('preHandler', async request => {
    requireAdmin(request)
    ensureSiteAuthority()
  })
  app.get('/tickets', async request => {
    const q = parse(paging, request.query)
    const where = and(q.search ? ilike(tickets.title, `%${q.search}%`) : undefined, q.status ? eq(tickets.status, q.status) : undefined)
    const rows = await ctx.db.select({ ticket: tickets, ownerEmail: users.email }).from(tickets)
      .innerJoin(users, eq(tickets.userId, users.id)).where(where).orderBy(desc(tickets.createdAt)).limit(q.limit).offset((q.page - 1) * q.limit)
    const [count] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(where)
    return { data: pageData(rows.map(row => ({ ...ticketToDto(row.ticket), ownerEmail: row.ownerEmail })), count?.n ?? 0, q.page, q.limit) }
  })

  app.get('/providers', async () => {
    const rows = await ctx.db.query.providers.findMany()
    const config = getConfig()
    const registered = new Set(listProviders().map(p => p.id))
    return { data: (['hetzner', 'leaseweb'] as const).map(id => {
      const settings = config.PROVIDERS[id]
      const row = rows.find(p => p.id === id)
      return { id, name: settings.displayName, enabled: row?.enabled ?? false,
        configured: settings.enabled && settings.orderingEnabled && registered.has(id) && row?.mode === 'live' }
    }) }
  })

  app.patch('/providers/:id', async request => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.enum(['hetzner', 'leaseweb']) }), request.params)
    const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), request.body)
    await ctx.db.transaction(async tx => {
      const [row] = await tx.select().from(providers).where(eq(providers.id, id)).for('update')
      if (!row) throw new NotFoundError('کاتالوگ این دیتاسنتر هنوز دریافت نشده است')
      if (row.enabled === enabled) return
      await tx.update(providers).set({ enabled, updatedAt: new Date() }).where(eq(providers.id, id))
      await writeAudit(tx, { actorId: admin.id, action: 'provider.sales_changed', targetType: 'provider',
        metadata: { providerId: id, previousEnabled: row.enabled, enabled } })
    })
    return { data: { id, enabled } }
  })

  app.get('/overview', async () => {
    const [userCount, orderCount, serverCount, activeCount, pendingCount, recent, paidTotal] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(users),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(orders),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(servers),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(servers).where(eq(servers.status, 'active')),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(inArray(orders.status, ['awaiting_payment', 'requires_review', 'provisioning'])),
      ctx.db.select().from(orders).orderBy(desc(orders.createdAt)).limit(5),
      ctx.db.select({ amount: sql<string>`coalesce(sum(${orders.totalRial}), 0)::text` }).from(orders)
        .where(inArray(orders.status, ['paid', 'queued', 'provisioning', 'active'])),
    ])
    const names = await userNames(ctx, recent.map(o => o.userId))
    const paid = Number(paidTotal[0]?.amount ?? 0)
    const total = money(paid)
    return { data: {
      source: 'website' as const,
      users: userCount[0]?.n ?? 0, orders: orderCount[0]?.n ?? 0,
      servers: serverCount[0]?.n ?? 0, activeServers: activeCount[0]?.n ?? 0,
      ordersNeedingAttention: pendingCount[0]?.n ?? 0,
      paidOrderTotalRial: total.balanceRial, paidOrderTotalToman: total.balanceToman,
      recentOrders: recent.map(o => ({ ...orderDto(o), userName: names.get(o.userId)?.name ?? '—' })),
    } }
  })

  app.get('/users', async request => {
    const q = parse(paging, request.query)
    const search: SQL | undefined = q.search ? or(
      ilike(users.email, `%${q.search}%`),
      ilike(users.firstName, `%${q.search}%`),
      ilike(users.lastName, `%${q.search}%`),
      ilike(users.mobile, `%${q.search}%`),
    ) : undefined
    const status: SQL | undefined = ['active', 'pending', 'disabled'].includes(q.status)
      ? eq(users.status, q.status as typeof users.$inferSelect.status) : undefined
    const condition = and(search, status)
    const [countRows, items] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(condition),
      ctx.db.select().from(users).where(condition).orderBy(desc(users.createdAt))
        .limit(q.limit).offset((q.page - 1) * q.limit),
    ])
    const ids = items.map(u => u.id)
    const [sums, serverCounts] = await Promise.all([
      ids.length ? ctx.db.select({
        userId: wallets.userId, amount: sql<string>`coalesce(sum(${wallets.balanceRial}), 0)::text`,
      }).from(wallets).where(inArray(wallets.userId, ids)).groupBy(wallets.userId) : [],
      ids.length ? ctx.db.select({
        userId: servers.userId, n: sql<number>`count(*)::int`,
      }).from(servers).where(inArray(servers.userId, ids)).groupBy(servers.userId) : [],
    ])
    const balances = new Map(sums.map(x => [x.userId, Number(x.amount)]))
    const counts = new Map(serverCounts.map(x => [x.userId, x.n]))
    return { data: pageData(items.map(u => ({
      ...userDto(u), ...money(balances.get(u.id) ?? 0), serverCount: counts.get(u.id) ?? 0,
    })), countRows[0]?.n ?? 0, q.page, q.limit) }
  })

  app.get('/users/:id', async request => {
    const { id } = parse(idParam, request.params)
    const user = await ctx.db.query.users.findFirst({ where: t => eq(t.id, id) })
    if (!user) throw new NotFoundError('کاربر یافت نشد')
    const [userWallets, txs, ownedServers, userOrders] = await Promise.all([
      ctx.db.query.wallets.findMany({ where: t => eq(t.userId, id), orderBy: t => [desc(t.isDefault), desc(t.createdAt)] }),
      ctx.db.query.walletTransactions.findMany({ where: t => eq(t.userId, id), orderBy: t => [desc(t.createdAt)], limit: 20 }),
      ctx.db.query.servers.findMany({ where: t => eq(t.userId, id), orderBy: t => [desc(t.createdAt)], limit: 20 }),
      ctx.db.query.orders.findMany({ where: t => eq(t.userId, id), orderBy: t => [desc(t.createdAt)], limit: 10 }),
    ])
    const total = userWallets.reduce((n, w) => n + w.balanceRial, 0)
    return { data: {
      user: userDto(user),
      ...money(total),
      wallets: userWallets.map(w => ({ id: w.id, name: w.name, currency: w.currency, isDefault: w.isDefault, ...money(w.balanceRial) })),
      transactions: txs.map(t => ({
        id: t.id, walletId: t.walletId, type: t.type, description: t.description,
        amountRial: t.amountRial, amountToman: rialToToman(t.amountRial),
        createdAt: t.createdAt.toISOString(),
      })),
      servers: ownedServers.map(serverDto),
      orders: userOrders.map(orderDto),
    } }
  })

  app.get('/users/:id/servers', async request => {
    const { id } = parse(idParam, request.params)
    const q = parse(paging, request.query)
    const user = await ctx.db.query.users.findFirst({ where: t => eq(t.id, id) })
    if (!user) throw new NotFoundError('کاربر یافت نشد')
    const search = q.search ? or(ilike(servers.hostname, `%${q.search}%`), ilike(servers.ipv4, `%${q.search}%`)) : undefined
    const condition = and(eq(servers.userId, id), search)
    const [counts, items] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(servers).where(condition),
      ctx.db.select().from(servers).where(condition).orderBy(desc(servers.createdAt))
        .limit(q.limit).offset((q.page - 1) * q.limit),
    ])
    return { data: pageData(items.map(serverDto), counts[0]?.n ?? 0, q.page, q.limit) }
  })

  app.get('/orders', async request => {
    const q = parse(paging, request.query)
    const owners = ctx.db.select({ id: users.id }).from(users).where(or(
      ilike(users.email, `%${q.search}%`),
      ilike(users.firstName, `%${q.search}%`),
      ilike(users.lastName, `%${q.search}%`),
    ))
    const search = q.search ? or(ilike(orders.orderNumber, `%${q.search}%`),
      ilike(orders.hostname, `%${q.search}%`), inArray(orders.userId, owners)) : undefined
    const validStatuses = ['draft', 'quoted', 'awaiting_payment', 'paid', 'queued', 'provisioning', 'active', 'failed', 'cancelled', 'requires_review', 'refunded']
    const status = validStatuses.includes(q.status) ? eq(orders.status, q.status as typeof orders.$inferSelect.status) : undefined
    const cond = and(search, status)
    const [countRows, items] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(cond),
      ctx.db.select().from(orders).where(cond).orderBy(desc(orders.createdAt))
        .limit(q.limit).offset((q.page - 1) * q.limit),
    ])
    const names = await userNames(ctx, items.map(o => o.userId))
    return { data: pageData(items.map(o => ({
      ...orderDto(o), userName: names.get(o.userId)?.name ?? '—', userEmail: names.get(o.userId)?.email ?? '',
    })), countRows[0]?.n ?? 0, q.page, q.limit) }
  })

  app.get('/orders/:id', async request => {
    const { id } = parse(idParam, request.params)
    const order = await ctx.db.query.orders.findFirst({ where: t => eq(t.id, id) })
    if (!order) throw new NotFoundError('سفارش یافت نشد')
    const [user, items, events, invoice] = await Promise.all([
      ctx.db.query.users.findFirst({ where: t => eq(t.id, order.userId) }),
      ctx.db.query.orderItems.findMany({ where: t => eq(t.orderId, id) }),
      ctx.db.query.orderEvents.findMany({ where: t => eq(t.orderId, id), orderBy: t => [desc(t.createdAt)] }),
      ctx.db.query.invoices.findFirst({ where: t => eq(t.orderId, id) }),
    ])
    return { data: {
      order: orderDto(order), user: user ? userDto(user) : null,
      items: items.map(i => ({ id: i.id, description: i.description, quantity: i.quantity, totalRial: i.totalRial, totalToman: rialToToman(i.totalRial) })),
      events: events.map(e => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, createdAt: e.createdAt.toISOString() })),
      invoice: invoice ? { id: invoice.id, number: invoice.invoiceNumber, status: invoice.status, totalRial: invoice.totalRial } : null,
    } }
  })

  // Admin-only: enumerate ALL configured Hetzner projects, including VMs
  // created directly in Hetzner Console. Persist provider facts locally,
  // but never create a website order, owner or financial entry implicitly.
  app.get('/hetzner/inventory', async () => {
    const fleet = await syncHetznerInventory(ctx.db, getConfig().PROVIDERS.hetzner)
    return { data: fleet }
  })

  app.get('/servers', async request => {
    const q = parse(paging, request.query)
    const owners = ctx.db.select({ id: users.id }).from(users).where(or(
      ilike(users.email, `%${q.search}%`),
      ilike(users.firstName, `%${q.search}%`),
      ilike(users.lastName, `%${q.search}%`),
    ))
    const search = q.search ? or(ilike(servers.hostname, `%${q.search}%`),
      ilike(servers.ipv4, `%${q.search}%`), ilike(servers.provider, `%${q.search}%`),
      inArray(servers.userId, owners)) : undefined
    const validStatuses = ['provisioning', 'active', 'suspended', 'terminated', 'failed']
    const status = validStatuses.includes(q.status) ? eq(servers.status, q.status as typeof servers.$inferSelect.status) : undefined
    const cond = and(search, status)
    const [countRows, items] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(servers).where(cond),
      ctx.db.select().from(servers).where(cond).orderBy(desc(servers.createdAt))
        .limit(q.limit).offset((q.page - 1) * q.limit),
    ])
    const names = await userNames(ctx, items.map(s => s.userId))
    return { data: pageData(items.map(s => ({
      ...serverDto(s), ownerName: names.get(s.userId)?.name ?? '—', ownerEmail: names.get(s.userId)?.email ?? '',
    })), countRows[0]?.n ?? 0, q.page, q.limit) }
  })

  app.get('/servers/:id', async request => {
    const { id } = parse(idParam, request.params)
    const s = await ctx.db.query.servers.findFirst({ where: t => eq(t.id, id) })
    if (!s) throw new NotFoundError('سرور یافت نشد')
    const owner = await ctx.db.query.users.findFirst({ where: t => eq(t.id, s.userId) })
    return { data: { server: serverDto(s), owner: owner ? userDto(owner) : null } }
  })
}
