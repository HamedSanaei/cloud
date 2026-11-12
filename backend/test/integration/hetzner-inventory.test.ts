import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HetznerConfig } from '../../src/config.js'
import { hetznerInventory } from '../../src/db/schema.js'
import { syncHetznerInventory } from '../../src/modules/providers/hetzner/inventory.js'
import { dbAvailable, getTestContext, truncateAll } from '../helpers.js'

const config: HetznerConfig = {
  enabled: true, orderingEnabled: false, baseUrl: 'https://api.hetzner.cloud/v1',
  displayName: 'Hetzner', accounts: [
    { id: 'project-a', label: 'Project A', priority: 1, enabled: true, state: 'active', apiToken: 'fake-project-a-secret' },
    { id: 'project-b', label: 'Project B', priority: 2, enabled: false, state: 'draining', apiToken: 'fake-project-b-secret' },
  ],
}
const machine = (id: number) => ({
  id, name: `srv-${id}`, status: 'running', created: '2026-11-11T10:00:00Z',
  server_type: { name: 'cx22', cores: 2, memory: 4, disk: 40 },
  datacenter: { name: 'fsn1-dc14' }, image: { name: 'ubuntu-24.04' },
  public_net: { ipv4: { ip: `198.51.100.${id}` } },
  user_data: 'never-expose-me',
})

describe.skipIf(!dbAvailable)('Hetzner complete read-only fleet snapshot (integration)', () => {
  let context: Awaited<ReturnType<typeof getTestContext>>

  beforeAll(async () => {
    context = await getTestContext()
    await truncateAll(context.db)
  })

  afterAll(async () => { await context?.close() })

  it('stores direct panel servers from all projects and follows pagination', async () => {
    const calls: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      const token = new Headers(init?.headers).get('authorization')
      calls.push(`${token}:${url.searchParams.get('page')}`)
      const first = token === 'Bearer fake-project-a-secret'
      const page = Number(url.searchParams.get('page'))
      return Response.json({
        servers: first ? [machine(page)] : page === 1 ? [machine(3)] : [],
        meta: { pagination: { next_page: first && page === 1 ? 2 : null } },
      })
    }
    const result = await syncHetznerInventory(context.db, config, fetcher)
    expect(result.items).toHaveLength(3)
    expect(result.items.every(s => s.source === 'hetzner' && s.websiteUserId === null)).toBe(true)
    expect(result.items.some(s => s.accountId === 'project-b' && s.name === 'srv-3')).toBe(true)
    expect(result.items[0]).toMatchObject({ serverType: 'cx22', location: 'fsn1-dc14', operatingSystem: 'ubuntu-24.04' })
    expect(JSON.stringify(result)).not.toMatch(/fake-project-a-secret|fake-project-b-secret|never-expose-me/)
    expect(calls).toEqual(['Bearer fake-project-a-secret:1', 'Bearer fake-project-a-secret:2', 'Bearer fake-project-b-secret:1'])
    expect(await context.db.select().from(hetznerInventory)).toHaveLength(3)
  })

  it('removes missing machines from the active inventory only after a complete refresh', async () => {
    const fetcher: typeof fetch = async () => Response.json({ servers: [], meta: { pagination: { next_page: null } } })
    const refreshed = await syncHetznerInventory(context.db, config, fetcher)
    expect(refreshed.items).toEqual([])
    const stored = await context.db.select().from(hetznerInventory)
    expect(stored).toHaveLength(3)
    expect(stored.every(s => !s.present)).toBe(true)
  })

  it('refuses incomplete account access without altering the snapshot', async () => {
    await expect(syncHetznerInventory(context.db, {
      ...config, accounts: [{ ...config.accounts[0]!, apiToken: '' }, config.accounts[1]!],
    }, async () => { throw new Error('must not fetch') })).rejects.toThrow(/توکن خواندن همه پروژه/)
    const stored = await context.db.select().from(hetznerInventory)
    expect(stored).toHaveLength(3)
  })
})
