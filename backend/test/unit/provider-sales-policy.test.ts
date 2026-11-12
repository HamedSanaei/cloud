import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbOrTx } from '../../src/db/index.js'
import { assertProviderPurchaseAllowed } from '../../src/modules/catalog/policy.js'

const fixtures = vi.hoisted(() => ({
  settings: { enabled: true, orderingEnabled: true },
  require: vi.fn(),
  user: { role: 'admin', status: 'active' },
}))
vi.mock('../../src/config.js', () => ({ getConfig: () => ({ NODE_ENV: 'production', PROVIDERS: { hetzner: fixtures.settings } }) }))
vi.mock('../../src/modules/providers/registry.js', () => ({ getProvider: () => ({ require: fixtures.require }) }))
function db() {
  return { select: () => ({ from: () => ({ where: () => ({ for: async () => [{ enabled: false }] }) }) }),
    query: { users: { findFirst: async () => fixtures.user } } } as unknown as DbOrTx
}
beforeEach(() => { fixtures.settings.enabled = true; fixtures.settings.orderingEnabled = true; fixtures.user.role = 'admin'; fixtures.user.status = 'active'; fixtures.require.mockReset() })

describe('admin sales exception preserves production technical gates', () => {
  it('allows an active admin through a disabled sales flag', async () => {
    await expect(assertProviderPurchaseAllowed(db(), 'hetzner', 'admin')).resolves.toBeUndefined()
    expect(fixtures.require).toHaveBeenCalledWith('provision')
  })
  it.each(['enabled', 'orderingEnabled'] as const)('refuses an admin when runtime %s is disabled', async flag => {
    fixtures.settings[flag] = false
    await expect(assertProviderPurchaseAllowed(db(), 'hetzner', 'admin')).rejects.toMatchObject({ code: 'validation_error' })
  })
  it('refuses a disabled admin or a normal user', async () => {
    fixtures.user.status = 'disabled'
    await expect(assertProviderPurchaseAllowed(db(), 'hetzner', 'admin')).rejects.toMatchObject({ code: 'forbidden' })
    fixtures.user.status = 'active'; fixtures.user.role = 'user'
    await expect(assertProviderPurchaseAllowed(db(), 'hetzner', 'customer')).rejects.toMatchObject({ code: 'forbidden' })
  })
})
