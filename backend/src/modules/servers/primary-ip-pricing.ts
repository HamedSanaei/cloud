import { randomUUID } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../db/index.js'
import { auditLogs, settings } from '../../db/schema.js'
import { writeAudit } from '../audit/service.js'

export const defaultPrimaryIpv4FeeRial = 1_500_000
export const maxPrimaryIpv4FeeRial = 1_000_000_000
const settingKey = (provider: string) => `primary_ipv4.fee.${provider}`
export const lockPrimaryIpv4Fee = (tx: DbOrTx, provider: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${settingKey(provider)}, 0))`)

export async function primaryIpv4Fee(db: DbOrTx, provider: string) {
  const row = await db.query.settings.findFirst({ where: t => eq(t.key, settingKey(provider)) })
  return (row?.value as { feeRial: number; version: string } | undefined) ?? { feeRial: defaultPrimaryIpv4FeeRial, version: 'default' }
}

export async function primaryIpv4Pricing(db: DbOrTx, provider: string) {
  const price = await primaryIpv4Fee(db, provider)
  const history = await db.select({ actorId: auditLogs.actorId, createdAt: auditLogs.createdAt, metadata: auditLogs.metadata })
    .from(auditLogs).where(sql`${auditLogs.action} = 'server.primary_ipv4.price_updated' and ${auditLogs.metadata}->>'provider' = ${provider}`)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(20)
  return { ...price, history }
}

export async function setPrimaryIpv4Fee(db: DbOrTx, actorId: string, provider: string, feeRial: number) {
  const key = settingKey(provider)
  return db.transaction(async tx => {
    await lockPrimaryIpv4Fee(tx, provider)
    const previous = await primaryIpv4Fee(tx, provider)
    if (feeRial === previous.feeRial) return previous
    const updatedAt = new Date(), value = { feeRial, version: randomUUID() }
    await tx.insert(settings).values({ key, value, updatedAt }).onConflictDoUpdate({
      target: settings.key, set: { value, updatedAt },
    })
    await writeAudit(tx, { actorId, action: 'server.primary_ipv4.price_updated', metadata: { provider, previousRial: previous.feeRial, feeRial } })
    return value
  })
}
