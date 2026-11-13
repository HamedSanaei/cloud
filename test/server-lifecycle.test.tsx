import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useServerFleet } from '../src/hooks/useServerFleet'
import { acceptedServers, claimLifecycleNotice, forgetAcceptedServer, rememberAcceptedServer } from '../src/lib/serverLifecycle'
import type { Server } from '../src/lib/types'

const { listServers, getServerTracking, showToast } = vi.hoisted(() => ({ listServers: vi.fn(), getServerTracking: vi.fn(), showToast: vi.fn() }))
vi.mock('../src/lib/endpoints', async original => ({ ...await original<typeof import('../src/lib/endpoints')>(), listServers, getServerTracking }))
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'fleet-test' } }) }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => ({ showToast }) }))
const user = 'fleet-test'
function pending(reference = crypto.randomUUID()): Server {
  return { id: `order:${reference}`, name: 'server-pending', status: 'building', lifecycle: 'queued', datacenter: 'hel1', cpu: '', ram: '', disk: '',
    tracking: { source: 'site', reference, orderId: reference, serverId: null, operationId: null, state: 'queued', createdAt: '', updatedAt: '' },
    power: { canPowerOn: false, canPowerOff: false, canReboot: false, billingBlocked: false, requiredBalanceToman: null, pendingAction: null } }
}
function ready(server: Server): Server { return { ...server, id: 'actual-server-id', status: 'active', lifecycle: 'ready', ip: '192.0.2.19', cpu: '2 vCPU', tracking: { ...server.tracking!, serverId: 'actual-server-id', state: 'ready' } } }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('indexedDB', new IDBFactory())
  for (const server of acceptedServers(user)) forgetAcceptedServer(user, server)
})
afterEach(() => vi.useRealTimers())
describe('authoritative provisioning and terminal notice claims', () => {
  it('deduplicates terminal notifications across concurrent tabs, remount and focus', async () => {
    const row = pending(), completed = ready(row)
    expect(await claimLifecycleNotice(user, ready(pending()))).toBe(false) // An old server is not a new build.
    await claimLifecycleNotice(user, row)
    const claims = await Promise.all([claimLifecycleNotice(user, completed), claimLifecycleNotice(user, completed)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await claimLifecycleNotice(user, completed)).toBe(false)
    expect(await claimLifecycleNotice('other-user', completed)).toBe(false)
  })
  it('does not consume a notice for an aborted StrictMode effect', async () => {
    const row = pending(); await claimLifecycleNotice(user, row)
    expect(await claimLifecycleNotice(user, ready(row), () => false)).toBe(false)
    expect(await claimLifecycleNotice(user, ready(row))).toBe(true)
  })
  it('keeps review and uncertain outcomes nonterminal, then claims a failure once after reconnect', async () => {
    const row = pending(); await claimLifecycleNotice(user, row)
    for (const state of ['outcome_unknown', 'requires_review'] as const) expect(await claimLifecycleNotice(user, { ...row, tracking: { ...row.tracking!, state } })).toBe(false)
    const failed = { ...row, tracking: { ...row.tracking!, state: 'failed' as const } }
    expect((await Promise.all([claimLifecycleNotice(user, failed), claimLifecycleNotice(user, failed)])).filter(Boolean)).toHaveLength(1)
    expect(await claimLifecycleNotice(user, ready(row))).toBe(false)
  })
  it('shows the accepted row immediately even when the list request has not returned, without success', async () => {
    const row = pending(); rememberAcceptedServer(user, row)
    listServers.mockReturnValue(new Promise(() => {}))
    const view = renderHook(() => useServerFleet(), { wrapper: StrictMode })
    await waitFor(() => expect(view.result.current.data[0]?.tracking?.reference).toBe(row.tracking!.reference))
    expect(showToast).not.toHaveBeenCalled()
    view.unmount()
  })
  it('replaces only completed rows, keeps uncertain rows, and stops targeted polling on unmount', async () => {
    const first = pending(), second = pending(); listServers.mockResolvedValue([first, second])
    getServerTracking.mockImplementation(async tracking => tracking.reference === first.tracking!.reference ? ready(first) : { ...second, lifecycle: 'outcome_unknown', tracking: { ...second.tracking!, state: 'outcome_unknown' } })
    const view = renderHook(() => useServerFleet())
    await waitFor(() => expect(view.result.current.data).toHaveLength(2))
    expect(showToast).not.toHaveBeenCalled()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('server-pending'), 'success', expect.any(String)), { timeout: 6500 })
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(view.result.current.data[0]).toMatchObject({ id: 'actual-server-id', ip: '192.0.2.19' })
    expect(view.result.current.data[1].tracking!.state).toBe('outcome_unknown')
    const signals = getServerTracking.mock.calls.map(call => call[1] as AbortSignal)
    act(() => view.unmount())
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })
  it('handles blocked browser storage without blocking a successfully accepted order', async () => {
    vi.stubGlobal('indexedDB', { open() { throw new Error('storage denied') } })
    expect(await claimLifecycleNotice(user, pending())).toBe(false)
  })
})
