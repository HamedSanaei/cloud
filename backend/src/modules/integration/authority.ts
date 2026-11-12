/**
 * Website ledger is canonical in site mode. The previous platform mode stays
 * intact for existing deployments until a frozen, reconciled cutover is
 * explicitly recorded. Never infer that an empty URL means balances moved.
 */
import type { DbClient } from '../../db/index.js'
import { desc, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'

export type Authority = 'site' | 'platform'

export function effectiveAuthority(config = getConfig()): Authority {
  if (config.DATA_AUTHORITY === 'site') return 'site'
  if (config.DATA_AUTHORITY === 'platform') return 'platform'
  return config.PLATFORM_API_URL ? 'platform' : 'site'
}

export function isSiteAuthority(): boolean { return effectiveAuthority() === 'site' }
export function isPlatformAuthority(): boolean { return effectiveAuthority() === 'platform' }

/**
 * This installation starts with no real Python-side financial or server data.
 * The website owns new business records. A stale Python URL alone is NOT a
 * reason to block a clean site deployment, because site mode never calls it.
 *
 * An existing platform binding is retained for rollback, but becomes unused
 * by site-mode routes. An audited empty-ledger cutover is required to permit it.
 */
export async function assertSiteAuthorityReady(db: DbClient): Promise<void> {
  if (!isSiteAuthority()) return
  const linked = await db.query.platformLinks.findFirst({ columns: { userId: true } })
  if (linked) {
    // Preserve the historical identity binding, but never consult it in
    // website mode. A verified empty-ledger cutover audit is mandatory.
    const receipt = await db.query.auditLogs.findFirst({
      where: t => eq(t.action, 'authority.site_empty_cutover'),
      orderBy: t => [desc(t.createdAt)],
    })
    const proof = receipt?.metadata as Record<string, unknown> | null | undefined
    if (proof?.siteCanonical !== true || proof?.moneyOrdersServersEmpty !== true ||
        proof?.linkCount !== 1 || typeof proof.releaseSha !== 'string' ||
        !/^[0-9a-f]{40}$/.test(proof.releaseSha)) {
      throw new Error('Site authority refused: no verified empty-ledger cutover for legacy platform binding')
    }
  }
}
