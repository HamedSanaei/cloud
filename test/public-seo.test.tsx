import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { renderHomepage } from '../src/home-entry'
import { publicPages } from '../src/public/metadata'
import { RootRoutes } from '../src/public/RootRoutes'
import { AuthProvider, ProtectedRoute } from '../src/auth/AuthContext'
import { AuthPage } from '../src/pages/AuthPages'
import * as auth from '../src/lib/auth'

it('renders distinct crawlable Persian public pages with one H1 and visible guide, FAQ and SSI fallback', () => {
  const home = renderHomepage('/'), hetzner = renderHomepage('/hetzner')
  for (const html of [home, hetzner]) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('h1')).toHaveLength(1)
    expect(doc.querySelector('#home-tariff-content')?.innerHTML).toContain('<!--# include')
    expect(doc.body.textContent).toContain('دریافت تعرفهٔ هتزنر موقتاً ممکن نیست.')
    expect(doc.querySelectorAll('main a[href^="#"]').length).toBeGreaterThan(0)
  }
  expect(home).toContain('href="/hetzner"')
  expect(home).toContain('landing-page landing-home')
  expect(home).toContain('href="/kalameh/home.css"')
  expect(hetzner).not.toContain('landing-home')
  expect(hetzner).not.toContain('/kalameh/home.css')
  expect(home).toContain('تعرفه سرور ایران')
  const homeDoc = new DOMParser().parseFromString(home, 'text/html')
  const hetznerCard = homeDoc.querySelector('.server-offer.rose')
  expect(hetznerCard?.querySelector('.server-offer-brand span')?.textContent).toBe('اروپا، آمریکا و سنگاپور · Hetzner')
  expect(hetznerCard?.querySelector('a')?.getAttribute('href')).toBe('/hetzner#tariffs')
  expect(hetzner).toContain('سرور ارزان هتزنر کدام است؟')
  expect(hetzner).toContain('«قیمت کم به زیاد» را انتخاب کنید')
  expect(hetzner).toContain('ثابت می‌ماند')
  expect(publicPages['/'].title).not.toBe(publicPages['/hetzner'].title)
  expect(publicPages['/'].description).not.toBe(publicPages['/hetzner'].description)
})

it.each([
  ['/login', 'ورود به حساب | پارس سرور', 'ورود امن'],
  ['/register', 'ساخت حساب | پارس سرور', 'ثبت‌نام امن'],
])('gives %s a distinct tab title and links to both public documents', async (path, title, badge) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  render(<MemoryRouter initialEntries={[path]}><AuthProvider><RootRoutes initialPath={path} /></AuthProvider></MemoryRouter>)
  expect((await screen.findByRole('link', { name: 'قوانین استفاده' })).getAttribute('href')).toBe('/terms')
  expect(screen.getByRole('link', { name: 'حریم خصوصی' }).getAttribute('href')).toBe('/privacy')
  expect(screen.getByText(badge)).toBeTruthy()
  expect(document.title).toBe(title)
})

it.each([['/terms', 'قوانین استفاده'], ['/privacy', 'حریم خصوصی']])('renders the document at %s for an anonymous visitor', (path, title) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  render(<MemoryRouter initialEntries={[path]}><AuthProvider><RootRoutes initialPath={path} /></AuthProvider></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy()
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3)
  expect(document.title).toBe(`${title} | پارس سرور`)
})

const intent = '/servers/create?offer=real-plan&period=monthly&location=hel1'
function CurrentPath() { const location = useLocation(); return <output data-testid="path">{location.pathname + location.search}</output> }
it('retains plan, period and location from anonymous entry through login and registration links and Google start', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  const google = vi.spyOn(auth, 'getGoogleLoginUrl').mockRejectedValue(new Error('Fixture stops before external OAuth'))
  try {
    render(<MemoryRouter initialEntries={[intent]}><AuthProvider><CurrentPath /><Routes>
      <Route element={<ProtectedRoute />}><Route path="servers/create" element={<p>Private quote</p>} /></Route>
      <Route path="login" element={<AuthPage intent="login" />} />
      <Route path="register" element={<AuthPage intent="register" />} />
    </Routes></AuthProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/login?returnTo=' + encodeURIComponent(intent)))
    fireEvent.click(screen.getByRole('link', { name: 'ثبت‌نام کنید' }))
    expect(screen.getByTestId('path').textContent).toBe('/register?returnTo=' + encodeURIComponent(intent))
    fireEvent.click(screen.getByRole('button', { name: /ادامه با گوگل/ }))
    await waitFor(() => expect(google).toHaveBeenCalledWith(intent))
    expect(screen.getByRole('link', { name: 'وارد شوید' }).getAttribute('href')).toBe('/login?returnTo=' + encodeURIComponent(intent))
  } finally { google.mockRestore() }
})

it('restores query intent after a fresh login page load and successful email login', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  const login = vi.spyOn(auth, 'startEmailLogin').mockResolvedValue({ token: 'fixture', user: { id: 'u', email: 'fixture@test.local', role: 'user', status: 'active' } })
  try {
    render(<MemoryRouter initialEntries={['/login?returnTo=' + encodeURIComponent(intent)]}><AuthProvider><CurrentPath /><Routes>
      <Route path="login" element={<AuthPage intent="login" />} />
      <Route path="servers/create" element={<p>Final quote entry</p>} />
    </Routes></AuthProvider></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('آدرس ایمیل'), { target: { value: 'fixture@test.local' } })
    fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'Safe-password-123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'ورود به حساب' }))
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(intent), { timeout: 2000 })
  } finally { login.mockRestore() }
})
