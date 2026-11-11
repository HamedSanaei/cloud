/**
 * Website ledger is canonical in site mode. The previous platform mode stays
 * intact for existing deployments until a frozen, reconciled cutover is
 * explicitly recorded. Never infer that an empty URL means balances moved.
 */
import type { DbClient } from '../../db/index.js'
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
 * However, an existing website-to-platform account binding can indicate a
 * second active writer. Require the operator to disconnect/delete unused test
 * bindings before enabling site mode; never silently pretend those links were
 * imported into the website ledger.
 */
export async function assertSiteAuthorityReady(db: DbClient): Promise<void> {
  if (!isSiteAuthority()) return
  const linked = await db.query.platformLinks.findFirst({ columns: { userId: true } })
  if (linked) {
    throw new Error(
      'Site authority refused: stale Python platform links exist. ' +
      'Disable the old writer and clean up unused test links before switching.',
    )
  }
}
