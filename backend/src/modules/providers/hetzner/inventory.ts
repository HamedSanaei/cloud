import { and, eq, inArray } from 'drizzle-orm'
import type { DbClient } from '../../../db/index.js'
import { hetznerInventory, servers } from '../../../db/schema.js'
import type { HetznerConfig } from '../../../config.js'
import { ConflictError } from '../../../lib/errors.js'
import { createHetznerProvider } from './live.js'

/**
 * Hetzner is only a source of infrastructure facts. Customer ownership,
 * orders, balances and billing always remain with the website.
 * Every configured account/project must be readable before a snapshot is
 * updated, otherwise an incomplete fleet could look like deleted servers.
 */
export async function syncHetznerInventory(db: DbClient, config: HetznerConfig, fetcher: typeof fetch = fetch) {
  if (!config.accounts.length) throw new ConflictError('هیچ پروژه یا توکن API هتزنر برای نمایش سرورها تنظیم نشده است')
  if (config.accounts.some(a => !a.apiToken)) {
    throw new ConflictError('برای فهرست کامل هتزنر، توکن خواندن همه پروژه‌های تنظیم‌شده لازم است')
  }
  const accounts = config.accounts.map(a => a.id)
  const fleet = await createHetznerProvider(config, { fetch: fetcher }).listServers()
  const stamp = new Date()
  const rows = fleet.map(machine => {
    const [accountId, externalId, extra] = machine.providerServerId.split(':')
    if (!accountId || !externalId || extra || !accounts.includes(accountId) || !/^[1-9][0-9]*$/.test(externalId)) {
      throw new ConflictError('شناسه سرور هتزنر معتبر نیست؛ فهرست ناقص ذخیره نشد')
    }
    const meta = machine.metadata ?? {}
    const createdAt = typeof meta.createdAt === 'string' ? new Date(meta.createdAt) : null
    return {
      providerServerId: machine.providerServerId, accountId,
      name: machine.hostname ?? machine.providerServerId, status: machine.state,
      ipv4: machine.ipv4 ?? null, ipv6: machine.ipv6 ?? null,
      vcpu: machine.vcpu ?? null, memoryMb: machine.memoryMb ?? null, diskGb: machine.diskGb ?? null,
      location: typeof meta.location === 'string' ? meta.location : null,
      serverType: typeof meta.serverType === 'string' ? meta.serverType : null,
      operatingSystem: typeof meta.operatingSystem === 'string' ? meta.operatingSystem : null,
      createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      lastSeenAt: stamp, present: true,
    }
  })
  if (new Set(rows.map(r => r.providerServerId)).size !== rows.length) {
    throw new ConflictError('فهرست هتزنر دارای شناسه تکراری است و همگام‌سازی متوقف شد')
  }
  await db.transaction(async tx => {
    await tx.update(hetznerInventory).set({ present: false }).where(inArray(hetznerInventory.accountId, accounts))
    for (const row of rows) {
      await tx.insert(hetznerInventory).values(row).onConflictDoUpdate({
        target: hetznerInventory.providerServerId, set: row,
      })
    }
  })
  const [inventory, websiteRows] = await Promise.all([
    db.select().from(hetznerInventory).where(and(eq(hetznerInventory.present, true), inArray(hetznerInventory.accountId, accounts))),
    db.select({ id: servers.id, providerServerId: servers.providerServerId, userId: servers.userId })
      .from(servers).where(eq(servers.provider, 'hetzner')),
  ])
  const byProviderId = new Map(websiteRows.filter(x => x.providerServerId).map(x => [x.providerServerId, x]))
  return {
    syncedAt: stamp.toISOString(),
    accounts: accounts.length,
    items: inventory.map(s => {
      const website = byProviderId.get(s.providerServerId)
      return {
        providerServerId: s.providerServerId, accountId: s.accountId,
        name: s.name, status: s.status, ipv4: s.ipv4, ipv6: s.ipv6,
        vcpu: s.vcpu, memoryMb: s.memoryMb, diskGb: s.diskGb,
        location: s.location, serverType: s.serverType, operatingSystem: s.operatingSystem,
        createdAt: s.createdAt?.toISOString() ?? null,
        lastSeenAt: s.lastSeenAt.toISOString(),
        source: website ? 'website' as const : 'hetzner' as const,
        websiteServerId: website?.id ?? null,
        websiteUserId: website?.userId ?? null,
      }
    }).sort((a,b) => a.name.localeCompare(b.name)),
  }
}
