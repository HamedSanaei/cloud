import { afterEach, expect, it, vi } from 'vitest'
import type { DbClient } from '../../src/db/index.js'
import { AppError } from '../../src/lib/errors.js'
import { getHomeTariffs } from '../../src/modules/catalog/home-tariffs.js'
import { getStorefront } from '../../src/modules/catalog/storefront.js'
import { isSiteAuthority } from '../../src/modules/integration/authority.js'
import { embeddedPrices, renderHomeTariffs } from '../../src/contracts/home-tariffs.js'

vi.mock('../../src/modules/catalog/storefront.js', () => ({ getStorefront: vi.fn() }))
vi.mock('../../src/modules/integration/authority.js', () => ({ isSiteAuthority: vi.fn(() => true) }))
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
const db = { query: { settings: { findFirst: async () => undefined } } } as unknown as DbClient
afterEach(() => { vi.clearAllMocks(); vi.mocked(isSiteAuthority).mockReturnValue(true) })

it('explains expired FX truthfully without exposing provider errors or forging a quote', async () => {
  vi.mocked(getStorefront).mockRejectedValue(new AppError(503, 'fx_rate_stale', 'Private provider details MUST NOT leak'))
  const data = await getHomeTariffs(db)
  expect(data.hetzner).toBeNull()
  expect(data.meta.status).toBe('pricing_unavailable')
  expect(data.meta.validUntil).toBe(data.meta.checkedAt)
  const html = renderHomeTariffs(data.iran, data.hetzner, data.meta, 'hetzner')
  expect(html).toContain('نرخ ارز معتبر')
  expect(JSON.stringify(data) + html).not.toContain('Private provider')
  expect(embeddedPrices(html)).toEqual(data)
})
it('does not fetch a privileged platform catalog for anonymous visitors', async () => {
  vi.mocked(isSiteAuthority).mockReturnValue(false)
  const data = await getHomeTariffs(db)
  expect(getStorefront).not.toHaveBeenCalled()
  expect(data.hetzner).toEqual([])
  expect(data.meta.status).toBe('not_published')
})
