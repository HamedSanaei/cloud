import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ServerConsole } from '../src/components/servers/ServerConsole'
import { requestServerConsole, revokeServerConsole } from '../src/lib/serverManagement'

const { viewers } = vi.hoisted(() => ({ viewers: [] as Array<EventTarget & { disconnect: () => void }> }))
vi.mock('@novnc/novnc', () => ({ default: class extends EventTarget {
  disconnect = vi.fn(() => this.dispatchEvent(new Event('disconnect')))
  constructor() { super(); viewers.push(this) }
} }))
vi.mock('../src/lib/serverManagement', () => ({ requestServerConsole: vi.fn(), revokeServerConsole: vi.fn() }))

const grant = () => ({ grantId: 'grant-1', password: 'fixture', expiresAt: new Date(Date.now() + 90_000).toISOString(), maxSessionSeconds: 300 })
const create = () => screen.getByRole<HTMLButtonElement>('button', { name: 'ایجاد نشست موقت' })
const end = () => screen.getByRole<HTMLButtonElement>('button', { name: 'پایان نشست' })
const open = (block: Parameters<typeof ServerConsole>[0]['block'] = null, openOperations = vi.fn()) => render(
  <MemoryRouter><ServerConsole serverId="test-server" block={block} recheck={vi.fn()} openOperations={openOperations} /></MemoryRouter>)

beforeEach(() => {
  vi.resetAllMocks(); viewers.length = 0
  vi.mocked(requestServerConsole).mockImplementation(async () => grant())
  vi.mocked(revokeServerConsole).mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

it('enables create only when idle and ends a temporary session while the viewer is connecting', async () => {
  open()
  expect(create().disabled).toBe(false)
  expect(end().disabled).toBe(true)
  fireEvent.click(create())
  expect(create().disabled).toBe(true)
  await screen.findByText(/نشست موقت ایجاد شده و هنوز متصل نیست/)
  expect(end().disabled).toBe(false)
  fireEvent.click(end())
  expect(viewers[0]?.disconnect).toHaveBeenCalledOnce()
  expect(revokeServerConsole).toHaveBeenCalledWith('test-server', 'grant-1')
  expect(screen.getByRole('status').textContent).toContain('نشست کنسول پایان یافت')
  expect(end().disabled).toBe(true)
  expect(create().disabled).toBe(false)
})

it('clears the connected session on disconnect and ignores late events', async () => {
  open()
  fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  const viewer = viewers[0]!
  act(() => viewer.dispatchEvent(new Event('connect')))
  expect(end().disabled).toBe(false)
  expect(screen.getByRole('status').textContent).toContain('کنسول متصل است')
  act(() => { viewer.dispatchEvent(new Event('disconnect')); viewer.dispatchEvent(new Event('connect')) })
  expect(screen.getByRole('status').textContent).toContain('ارتباط قطع شد')
  expect(end().disabled).toBe(true)
  expect(create().disabled).toBe(false)
  expect(revokeServerConsole).not.toHaveBeenCalled()
})

it('revokes a grant that arrives after leaving the console tab and never creates a viewer for it', async () => {
  let resolve!: (value: ReturnType<typeof grant>) => void
  vi.mocked(requestServerConsole).mockReturnValue(new Promise(done => { resolve = done }))
  const view = open()
  fireEvent.click(create())
  await waitFor(() => expect(requestServerConsole).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () => resolve(grant()))
  expect(revokeServerConsole).toHaveBeenCalledWith('test-server', 'grant-1')
  expect(viewers).toHaveLength(0)
})

it('explains the operation lock next to Create and links to the available recovery action', () => {
  const openOperations = vi.fn()
  open('operation_pending', openOperations)
  expect(create().disabled).toBe(true)
  expect(end().disabled).toBe(true)
  expect(document.getElementById(create().getAttribute('aria-describedby')!)?.textContent).toContain('عملیات قبلی')
  fireEvent.click(screen.getByRole('button', { name: 'مشاهدهٔ عملیات' }))
  expect(openOperations).toHaveBeenCalledOnce()
})
