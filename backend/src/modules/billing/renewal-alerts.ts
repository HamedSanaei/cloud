import { eq, sql } from 'drizzle-orm'
import type { DbClient, DbOrTx } from '../../db/index.js'
import { settings, systemEvents } from '../../db/schema.js'
import { NotFoundError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { latestApprovedEuro } from '../pricing/renewal.js'
import { euroRefreshIntervalMs, fxMaxAgeMs } from '../pricing/service.js'

const prefix = 'billing.renewal-alert.'
const hourMs = 3_600_000
type AlertDetails = { subscriptionId?: string; serverId?: string | null; dueAt?: string; code: string; fxAgeMs?: number }
type RenewalAlert = AlertDetails & {
  id: string; level: 'warn' | 'critical'; status: 'active' | 'acknowledged' | 'resolved'
  createdAt: string; lastSeenAt: string; actorId?: string; actedAt?: string; lastPaidAt?: string; overduePeriods: number
}
async function recordTransition(tx: DbOrTx, action: string, alert: RenewalAlert, actorId?: string) {
  const metadata = { alertId: alert.id, level: alert.level, status: alert.status, code: alert.code, subscriptionId: alert.subscriptionId,
    serverId: alert.serverId, dueAt: alert.dueAt, fxAgeMs: alert.fxAgeMs, overduePeriods: alert.overduePeriods, lastPaidAt: alert.lastPaidAt }
  await tx.insert(systemEvents).values({ service: 'billing', event: action, level: alert.level, metadata })
  await writeAudit(tx, { action, actorId, targetType: 'subscription', targetId: alert.subscriptionId, metadata })
}
function lockAlert(tx: DbOrTx, key: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

export async function observeRenewalAlert(tx: DbOrTx, details: AlertDetails, level: RenewalAlert['level'] = 'critical') {
  const id = `${details.subscriptionId ?? 'eur'}.${details.code}`
  const key = prefix + id
  await lockAlert(tx, key)
  const previous = (await tx.query.settings.findFirst({ where: t => eq(t.key, key) }))?.value as RenewalAlert | undefined
  const now = new Date()
  const ongoing = previous && previous.status !== 'resolved' ? previous : undefined
  const dueAt = ongoing?.dueAt ?? details.dueAt
  const lastPaid = details.subscriptionId ? await tx.query.invoices.findFirst({
    where: (t, { and }) => and(eq(t.subscriptionId, details.subscriptionId!), eq(t.status, 'paid')),
    columns: { paidAt: true }, orderBy: (t, { desc }) => [desc(t.paidAt)],
  }) : undefined
  const value: RenewalAlert = { ...details, dueAt, id, level, status: ongoing?.status ?? 'active',
    createdAt: ongoing?.createdAt ?? now.toISOString(), lastSeenAt: now.toISOString(),
    actorId: ongoing?.actorId, actedAt: ongoing?.actedAt, lastPaidAt: lastPaid?.paidAt?.toISOString(),
    overduePeriods: details.dueAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(details.dueAt)) / hourMs) + 1) : 0 }
  if (ongoing?.level === 'critical') value.level = 'critical'
  await tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
  if (!ongoing || ongoing.level !== value.level) await recordTransition(tx, details.code === 'renewal_fx_unavailable' && details.subscriptionId
    ? 'subscription.renewal_blocked' : 'billing.renewal_alert', value)
}

export async function monitorEuroRenewals(db: DbClient, age: number | undefined) {
  const details = { code: 'renewal_eur_fx_health', fxAgeMs: age }
  if (age === undefined || age >= fxMaxAgeMs('EUR') - 2 * euroRefreshIntervalMs) {
    await db.transaction(tx => observeRenewalAlert(tx, details, age === undefined || age >= fxMaxAgeMs('EUR') ? 'critical' : 'warn'))
  } else await db.transaction(tx => resolveRenewalAlerts(tx, 'eur.'))
}

async function alertRows(db: DbOrTx, scope = '') {
  const keyPrefix = prefix + scope
  return db.query.settings.findMany({ where: t => sql`left(${t.key}, ${keyPrefix.length}) = ${keyPrefix}`,
    orderBy: (t, { desc }) => [desc(t.updatedAt)] })
}

export async function listRenewalAlerts(db: DbClient, actorId: string) {
  const rows = await alertRows(db)
  await writeAudit(db, { actorId, action: 'billing.renewal_alerts_viewed' })
  return rows.map(row => row.value as RenewalAlert)
}

export async function resolveRenewalAlerts(tx: DbOrTx, scope: string) {
  for (const row of await alertRows(tx, scope)) {
    if ((row.value as RenewalAlert).status === 'resolved') continue
    await lockAlert(tx, row.key)
    const alert = (await tx.query.settings.findFirst({ where: t => eq(t.key, row.key) }))?.value as RenewalAlert | undefined
    if (!alert || alert.status === 'resolved') continue
    const value: RenewalAlert = { ...alert, status: 'resolved', actedAt: new Date().toISOString(), overduePeriods: 0 }
    await tx.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, row.key))
    await recordTransition(tx, 'billing.renewal_alert_resolved', value)
  }
}

export async function acknowledgeRenewalAlert(db: DbClient, id: string, actorId: string) {
  return db.transaction(async tx => {
    const key = prefix + id
    await lockAlert(tx, key)
    const alert = (await tx.query.settings.findFirst({ where: t => eq(t.key, key) }))?.value as RenewalAlert | undefined
    if (!alert) throw new NotFoundError()
    if (alert.status !== 'active') return alert
    const value: RenewalAlert = { ...alert, actorId, actedAt: new Date().toISOString(), status: 'acknowledged' }
    await tx.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
    await recordTransition(tx, `billing.renewal_alert_${value.status}`, value, actorId)
    return value
  })
}
