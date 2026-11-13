import { describe, expect, it } from 'vitest'
import { createHetznerProvider } from '../../src/modules/providers/hetzner/live.js'
import { hetznerCommands } from '../../src/modules/providers/hetzner/customer.js'
import type { ManagementAction } from '../../src/modules/providers/customer.interface.js'

describe('explicit Hetzner customer commands and owning project', () => {
  it('uses distinct commands, allowlisted payloads and only the original project credential', async () => {
    const requests: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = []
    const provider = createHetznerProvider({ enabled: true, orderingEnabled: true, displayName: 'Fixture', baseUrl: 'https://fixture.test/v1', accounts: [
      { id: 'alpha', label: 'alpha', enabled: true, state: 'active', priority: 1, apiToken: 'fixture-alpha' },
      { id: 'beta', label: 'beta', enabled: false, state: 'disabled', priority: 2, apiToken: 'fixture-beta' },
    ] }, { fetch: async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, authorization: new Headers(init?.headers).get('authorization') })
      return Response.json({ action: { id: 123, status: 'running' } })
    } })
    const input = { serverType: 'cx-fixture', upgradeDisk: true, image: '11', iso: '22', delete: false, rebuild: true, apiToken: 'must-not-forward', priceRial: 1 }
    for (const action of Object.keys(hetznerCommands) as ManagementAction[]) await provider.customer!.submit('beta:42', action, input)
    expect(requests.every(r => r.authorization === 'Bearer fixture-beta')).toBe(true)
    expect(requests.map(r => r.path)).toEqual(Object.entries(hetznerCommands).map(([action, command]) => action === 'delete' ? '/v1/servers/42' : `/v1/servers/42/actions/${command}`))
    expect(requests.find(r => r.method === 'DELETE')!.body).toBeNull()
    expect(requests.find(r => r.path.endsWith('/change_type'))!.body).toEqual({ server_type: 'cx-fixture', upgrade_disk: true })
    expect(requests.find(r => r.path.endsWith('/rebuild'))!.body).toEqual({ image: 11 })
    expect(JSON.stringify(requests)).not.toContain('must-not-forward')
    await expect(provider.customer!.submit('42', 'power_on', {})).rejects.toThrow(/Explicit owning project/)
    await expect(provider.customer!.submit('unknown:42', 'delete', {})).rejects.toThrow(/ownership/)
    expect(requests).toHaveLength(Object.keys(hetznerCommands).length)
  })
  it('recognizes absence only from an authenticated not_found response, never from denied access', async () => {
    let status = 403
    const provider = createHetznerProvider({ enabled: true, orderingEnabled: true, displayName: 'Fixture', baseUrl: 'https://fixture.test/v1', accounts: [
      { id: 'alpha', label: 'alpha', enabled: true, state: 'active', priority: 1, apiToken: 'fixture-alpha' },
    ] }, { fetch: async () => Response.json({ error: { code: status === 404 ? 'not_found' : 'forbidden' } }, { status }) })
    await expect(provider.customer!.absent('alpha:42')).rejects.toThrow()
    status = 404; expect(await provider.customer!.absent('alpha:42')).toBe(true)
  })
})
