import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ServerConsole } from '../src/components/servers/ServerConsole'
import { requestServerConsole, revokeServerConsole } from '../src/lib/serverManagement'
import userEvent from '@testing-library/user-event'
import { consoleSessionExpiredCode } from '../backend/src/contracts/server-console'

const { viewers } = vi.hoisted(() => ({ viewers: [] as Array<EventTarget & { disconnect: () => void; focus: () => void; blur: () => void; sendKey: (...args: unknown[]) => void }> }))
vi.mock('@novnc/novnc', () => ({ default: class extends EventTarget {
  disconnect = vi.fn(() => this.dispatchEvent(new Event('disconnect')))
  focus = vi.fn()
  blur = vi.fn()
  sendKey = vi.fn()
  constructor() { super(); viewers.push(this) }
} }))
const sockets: EventTarget[] = []
vi.mock('../src/lib/serverManagement', () => ({ requestServerConsole: vi.fn(), revokeServerConsole: vi.fn() }))

const grant = () => ({ grantId: 'grant-1', password: 'fixture', expiresAt: new Date(Date.now() + 90_000).toISOString(), maxSessionSeconds: 300 })
const create = () => screen.getByRole<HTMLButtonElement>('button', { name: 'ایجاد نشست موقت' })
const end = () => screen.getByRole<HTMLButtonElement>('button', { name: 'پایان نشست' })
const open = (block: Parameters<typeof ServerConsole>[0]['block'] = null, openOperations = vi.fn()) => render(
  <MemoryRouter><ServerConsole serverId="test-server" block={block} recheck={vi.fn()} openOperations={openOperations} /></MemoryRouter>)

beforeEach(() => {
  vi.resetAllMocks(); viewers.length = 0
  sockets.length = 0
  vi.stubGlobal('WebSocket', class extends EventTarget {
    static CLOSING = 2
    readyState = 1
    close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: 1000 })) })
    constructor() { super(); sockets.push(this) }
  })
  vi.mocked(requestServerConsole).mockImplementation(async () => grant())
  vi.mocked(revokeServerConsole).mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

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

it('shows a localized error and revokes the grant when the upstream connection fails', async () => {
  open()
  fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  act(() => viewers[0]?.dispatchEvent(new Event('disconnect')))
  expect(screen.getByRole('status').textContent).toContain('ارتباط با کنسول سرور برقرار نشد')
  expect(revokeServerConsole).toHaveBeenCalledWith('test-server', 'grant-1')
  expect(create().disabled).toBe(false)
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

it('provides a keyboard entry, preserves guest Tab, and releases modifiers when returning to page controls', async () => {
  const user = userEvent.setup()
  open(); fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  act(() => viewers[0].dispatchEvent(new Event('connect')))
  const entry = screen.getByRole('button', { name: 'ورود با صفحه‌کلید به کنسول' })
  entry.focus(); await user.keyboard('{Enter}')
  expect(viewers[0].focus).toHaveBeenCalledOnce()
  const viewer = document.getElementById(entry.getAttribute('aria-controls')!)!
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  fireEvent(viewer, tab)
  expect(tab.defaultPrevented).toBe(false)
  fireEvent.keyDown(viewer, { key: 'Escape', ctrlKey: true, altKey: true })
  expect(viewers[0].blur).toHaveBeenCalledOnce()
  expect(viewers[0].sendKey).toHaveBeenCalledWith(0xffe3, 'ControlLeft', false)
  expect(document.activeElement).toBe(entry)
  expect(document.getElementById(entry.getAttribute('aria-describedby')!)?.textContent).toContain('Ctrl + Alt + Escape')
})

it('expands the same connected viewer without reconnecting or requesting a second grant', async () => {
  open(); fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  act(() => viewers[0].dispatchEvent(new Event('connect')))
  const expand = screen.getByRole('button', { name: 'بزرگ‌کردن کنسول' })
  const target = document.getElementById(expand.getAttribute('aria-controls')!)
  fireEvent.click(expand)
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(target?.closest('.server-console--expanded')).toBeTruthy()
  expect(document.getElementById(expand.getAttribute('aria-controls')!)).toBe(target)
  fireEvent.click(screen.getByRole('button', { name: 'اندازهٔ معمول کنسول' }))
  expect(target?.closest('.server-console--expanded')).toBeNull()
  expect(viewers).toHaveLength(1)
  expect(viewers[0].disconnect).not.toHaveBeenCalled()
  expect(requestServerConsole).toHaveBeenCalledOnce()
})

it('labels an authoritative proxy deadline as expiry even before the client timer fires', async () => {
  open(); fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  act(() => viewers[0].dispatchEvent(new Event('connect')))
  act(() => sockets[0].dispatchEvent(new CloseEvent('close', { code: consoleSessionExpiredCode })))
  expect(screen.getByRole('status').textContent).toContain('مهلت نشست موقت کنسول به پایان رسید')
  expect(screen.getByRole('status').textContent).not.toContain('ارتباط قطع شد')
  expect(create().disabled).toBe(false)
  fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(2))
})

it('uses expiry wording for the client session deadline too', async () => {
  open(); fireEvent.click(create())
  await waitFor(() => expect(viewers).toHaveLength(1))
  vi.useFakeTimers()
  act(() => viewers[0].dispatchEvent(new Event('connect')))
  act(() => vi.advanceTimersByTime(300_000))
  expect(screen.getByRole('status').textContent).toContain('مهلت نشست موقت کنسول به پایان رسید')
  expect(create().disabled).toBe(false)
})
