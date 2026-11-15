import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ServerTableRow } from '../src/components/servers/ServerPrimitives'
import type { Server } from '../src/lib/types'
// @ts-expect-error Synthetic shared test fixture; no real provider calls.
import { readyServer } from './server-management-fixtures.mjs'

const empty: Server = { ...readyServer, status: 'building', cpu: '', ram: '', disk: '', datacenter: '', serverType: undefined, os: undefined }
const row = (server: Server) => <MemoryRouter><table><tbody><ServerTableRow server={server} /></tbody></table></MemoryRouter>
const resourcesCell = () => document.querySelector<HTMLTableCellElement>('td[data-label="منابع"]')!

describe('server list resource availability', () => {
  it.each(['failed', 'cancelled', 'terminated', 'ready', 'delete_failed', 'deletion_requested', 'deleting', 'requires_review', 'outcome_unknown'] as const)('does not imply that missing %s resources are still loading', lifecycle => {
    render(row({ ...empty, lifecycle }))
    expect(within(resourcesCell()).getAllByText('در دسترس نیست')).toHaveLength(2)
    expect(within(resourcesCell()).queryByText('در حال دریافت')).toBeNull()
  })

  it.each(['queued', 'provisioning'] as const)('keeps the loading hint for %s', lifecycle => {
    render(row({ ...empty, lifecycle }))
    expect(within(resourcesCell()).getAllByText('در حال دریافت')).toHaveLength(2)
  })

  it('preserves the recorded plan, resources and location of a failed order', () => {
    const server: Server = { ...readyServer, lifecycle: 'failed', status: 'building' }
    const original = structuredClone(server)
    render(row(server))
    expect(resourcesCell().textContent).toContain(`${server.serverType} · ${server.cpu} · ${server.ram} · ${server.disk}`)
    expect(resourcesCell().textContent).toContain(server.datacenter)
    expect(resourcesCell().textContent).toContain(server.os)
    expect(resourcesCell().textContent).not.toContain('در حال دریافت')
    expect(server).toEqual(original)
  })

  it('shows a recorded plan even when its failed resource allocation is unavailable', () => {
    render(row({ ...empty, lifecycle: 'failed', serverType: 'CX23' }))
    expect(resourcesCell().textContent).toContain('CX23 · در دسترس نیست')
  })

  it('preserves partial resource data instead of replacing it with a placeholder', () => {
    render(row({ ...empty, lifecycle: 'failed', ram: '4096 MB' }))
    expect(resourcesCell().textContent).toContain('4096 MB')
    expect(resourcesCell().textContent).not.toContain('در حال دریافت')
  })

  it('uses tracking state when lifecycle is absent and stays unavailable after refresh', () => {
    const server: Server = { ...empty, lifecycle: undefined, tracking: { ...readyServer.tracking, state: 'failed' } }
    const view = render(row(server))
    expect(resourcesCell().textContent).not.toContain('در حال دریافت')
    view.rerender(row(structuredClone(server)))
    expect(resourcesCell().textContent).not.toContain('در حال دریافت')
    expect(screen.getByText('خطای ساخت')).toBeTruthy()
  })

  it('replaces the loading hint when a pending order becomes failed', () => {
    const view = render(row({ ...empty, lifecycle: 'provisioning' }))
    expect(resourcesCell().textContent).toContain('در حال دریافت')
    view.rerender(row({ ...empty, lifecycle: 'failed' }))
    expect(resourcesCell().textContent).not.toContain('در حال دریافت')
    expect(resourcesCell().textContent).toContain('در دسترس نیست')
  })
})
