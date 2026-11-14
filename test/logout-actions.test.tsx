import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { AppShell } from '../src/components/layout/AppShell'
import { AdminLayout } from '../src/admin/AdminLayout'
import { SessionsPage } from '../src/pages/AccountPages'
import { ToastProvider } from '../src/components/ui/Toast'
import { LogoutButton } from '../src/components/ui/LogoutButton'
// @ts-expect-error Synthetic fixtures shared with the loopback preview.
import { fixture } from './fixtures.mjs'

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }))
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { role: 'admin', status: 'active', email: 'fixture@example.test' }, loading: false, logout }) }))
let requests: Array<{ path: string; method: string }>
beforeEach(() => {
  logout.mockReset().mockResolvedValue(undefined); localStorage.clear(); requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, '').split('?')[0]; requests.push({ path, method: init?.method ?? 'GET' })
    return Response.json(path === '/sessions' ? { data: [{ id: 'current', current: true, device: 'Fixture browser', location: 'Fixture', lastActivity: 'now' }] } : fixture(path))
  }))
})
function open(path = '/dashboard') {
  return render(<MemoryRouter initialEntries={[path]}><ToastProvider><Routes>
    <Route element={<AppShell />}><Route path="/dashboard" element={<p>Dashboard fixture</p>} /><Route path="/sessions" element={<SessionsPage />} /></Route>
    <Route path="/login" element={<p>Login fixture</p>} />
    <Route path="/admin" element={<AdminLayout />}><Route index element={<p>Admin fixture</p>} /><Route path="users" element={<p>Users fixture</p>} /></Route>
  </Routes></ToastProvider></MemoryRouter>)
}
describe('shared danger treatment for actual sign-out actions', () => {
  it.each(['desktop', 'mobile drawer'])('keeps customer %s logout semantic and preserves sign-out routing', async mode => {
    const user = userEvent.setup(); open()
    if (mode === 'mobile drawer') {
      await user.click(screen.getByRole('button', { name: 'باز کردن منو' }))
      expect(document.querySelector('.sidebar--open')).toBeTruthy()
    }
    const exit = screen.getByRole('button', { name: 'خروج', exact: true })
    expect(exit.classList.contains('logout-action')).toBe(true)
    expect(screen.getByRole('link', { name: 'صفحه اصلی سایت' }).classList.contains('logout-action')).toBe(false)
    await user.click(exit)
    expect(await screen.findByText('Login fixture')).toBeTruthy(); expect(logout).toHaveBeenCalledTimes(1)
  })
  it('styles admin logout separately from its Back link without changing its handler', async () => {
    open('/admin/users')
    const nav = screen.getByRole('complementary', { name: 'ناوبری پنل مدیریت' })
    expect(within(nav).getByRole('button', { name: 'خروج' }).classList.contains('logout-action')).toBe(true)
    expect(within(nav).getByRole('link', { name: 'ناحیه کاربری' }).classList.contains('logout-action')).toBe(false)
    await userEvent.click(within(nav).getByRole('button', { name: 'خروج' }))
    expect(await screen.findByText('Admin fixture')).toBeTruthy(); expect(logout).toHaveBeenCalledTimes(1)
  })
  it('keeps session revocation red while loading and preserves its DELETE request', async () => {
    let finish: (response: Response) => void = () => undefined
    const fetcher = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/sessions/others')
      ? new Promise<Response>(resolve => { requests.push({ path: '/sessions/others', method: init?.method ?? 'GET' }); finish = resolve }) : fetcher(url, init)))
    open('/sessions')
    const button = await screen.findByRole('button', { name: 'خروج از سایر نشست‌ها' })
    expect(button.classList.contains('logout-action')).toBe(true)
    await userEvent.click(button)
    expect((screen.getByRole('button', { name: 'در حال خروج...' }) as HTMLButtonElement).disabled).toBe(true)
    expect(button.classList.contains('logout-action')).toBe(true)
    finish(Response.json({ data: { revoked: 1 } }))
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect(requests.filter(r => r.path === '/sessions/others')).toEqual([{ path: '/sessions/others', method: 'DELETE' }])
    expect(logout).not.toHaveBeenCalled()
  })
  it('supports future controls as a native keyboard-focusable, non-submitting button', async () => {
    const action = vi.fn(), view = render(<LogoutButton onClick={action}>Sign out fixture</LogoutButton>)
    const button = screen.getByRole('button', { name: 'Sign out fixture' }) as HTMLButtonElement
    expect(button.type).toBe('button')
    await userEvent.tab(); expect(document.activeElement).toBe(button)
    await userEvent.keyboard('{Enter}'); expect(action).toHaveBeenCalledTimes(1)
    view.rerender(<LogoutButton disabled onClick={action}>Sign out fixture</LogoutButton>)
    await userEvent.click(button); expect(action).toHaveBeenCalledTimes(1)
  })
  it.each(['light', 'dark'])('keeps danger text/borders/focus above 4.5:1 against every %s action surface', theme => {
    const css = readFileSync('src/styles.css', 'utf8')
    const block = theme === 'light' ? css.split(":root[data-theme='dark']")[0] : css.split(":root[data-theme='dark']")[1].split('}')[0]
    const token = (name: string) => block.match(new RegExp(`--${name}: (#[a-f0-9]{6});`))![1]
    const luminance = (hex: string) => {
      const rgb = hex.slice(1).match(/../g)!.map(c => { const v = parseInt(c, 16) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 })
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
    }
    for (const background of ['danger-soft', 'danger-hover', 'danger-active']) {
      const [a, b] = [luminance(token('danger-ink')), luminance(token(background))].sort((a, b) => b - a)
      expect((a + .05) / (b + .05)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
