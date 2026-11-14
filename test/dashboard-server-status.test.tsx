import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { DashboardPage } from '../src/pages/DashboardPage'
import { ServerTableRow } from '../src/components/servers/ServerPrimitives'
import type { Server } from '../src/lib/types'
// @ts-expect-error Synthetic JS fixture shared with the loopback preview.
import { readyServer } from './server-management-fixtures.mjs'
// @ts-expect-error Synthetic JS fixture shared with the loopback preview.
import { fixture } from './fixtures.mjs'

let servers: Server[]
beforeEach(() => {
  servers = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(/^\/api/, '').split('?')[0]
    return Response.json(path === '/servers' ? { data: servers } : fixture(path))
  }))
})

async function open() {
  const view = render(<MemoryRouter>
    <DashboardPage />
    <table aria-label="Fixture server list"><tbody>{servers.map(server => <ServerTableRow key={server.id} server={server} />)}</tbody></table>
  </MemoryRouter>)
  const dashboard = within(view.container.querySelector('.dashboard-servers') as HTMLElement)
  await dashboard.findByText(servers[0].name)
  return { dashboard, list: within(screen.getByRole('table', { name: 'Fixture server list' })) }
}

describe('dashboard server lifecycle status', () => {
  it('distinguishes confirmed deletions from powered-off servers and matches the server list', async () => {
    servers = [
      { ...readyServer, id: 'deleted-a', name: 'Deleted A', status: 'inactive', lifecycle: 'terminated' },
      { ...readyServer, id: 'deleted-b', name: 'Deleted B', status: 'inactive', lifecycle: 'terminated' },
      { ...readyServer, id: 'stopped', name: 'Stopped server', status: 'inactive', lifecycle: 'ready' },
    ]
    const original = structuredClone(servers)
    const { dashboard, list } = await open()
    for (const server of servers) {
      const dashboardRow = dashboard.getByText(server.name).closest('tr')!
      const listRow = list.getByText(server.name).closest('tr')!
      const status = within(dashboardRow).getAllByRole('cell')[1]
      expect(status.textContent).toBe(within(listRow).getAllByRole('cell')[1].textContent)
      if (server.lifecycle === 'terminated') {
        expect(status.textContent).toBe('حذف تأیید شد')
        expect(within(status).queryByText('خاموش')).toBeNull()
      } else {
        expect(within(status).getByText('خاموش')).toBeTruthy()
        expect(within(status).queryByText('حذف تأیید شد')).toBeNull()
      }
    }
    expect(dashboard.queryByText('inactive')).toBeNull()
    expect(servers).toEqual(original)
  })

  it.each([
    ['deleting', 'در حال حذف'],
    ['delete_failed', 'حذف ناموفق'],
    ['outcome_unknown', 'نتیجه نامشخص'],
    ['provisioning', 'در حال ساخت سرور…'],
  ] as const)('shows the localized %s lifecycle rather than raw power status', async (lifecycle, label) => {
    servers = [{ ...readyServer, lifecycle }]
    const { dashboard } = await open()
    expect(dashboard.getByText(label)).toBeTruthy()
    expect(dashboard.queryByText('active')).toBeNull()
  })

  it('uses tracking state when lifecycle is absent', async () => {
    servers = [{ ...readyServer, lifecycle: undefined, tracking: { ...readyServer.tracking, state: 'queued' } }]
    const { dashboard } = await open()
    expect(dashboard.getByText('در صف ساخت')).toBeTruthy()
    expect(dashboard.queryByText('آماده / تأییدشده')).toBeNull()
  })

  it.each([
    ['active', 'آماده / تأییدشده'],
    ['inactive', 'خاموش'],
    ['building', 'در حال ساخت سرور…'],
  ] as const)('keeps legacy %s records localized without claiming deletion', async (status, label) => {
    servers = [{ ...readyServer, status, lifecycle: undefined, tracking: undefined }]
    const { dashboard } = await open()
    expect(dashboard.getByText(label)).toBeTruthy()
    expect(dashboard.queryByText(status)).toBeNull()
    expect(dashboard.queryByText('حذف تأیید شد')).toBeNull()
  })
})
