import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { App } from '../src/App'
import { AuthProvider } from '../src/auth/AuthContext'
import { ToastProvider } from '../src/components/ui/Toast'
// @ts-expect-error JS fixtures deliberately shared with the isolated preview server.
import { fixture, offerId } from './fixtures.mjs'

let requests: Array<{ path: string; method: string; body: Record<string, unknown>; key?: string }>
beforeEach(() => {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, '').split('?')[0]
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {}, key: (init?.headers as Record<string, string>)?.['idempotency-key'] })
    return new Response(JSON.stringify(fixture(path)), { headers: { 'content-type': 'application/json' } })
  }))
})
function open(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></MemoryRouter>)
}

async function reviewOrder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Hetzner/ }))
  await user.selectOptions(screen.getByLabelText('موقعیت سرور'), 'fsn1')
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.click(screen.getByRole('button', { name: /ساعتی.*پرداخت/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.click(screen.getByRole('button', { name: /CX Preview/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.click(await screen.findByRole('button', { name: 'Ubuntu 24.04' }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.selectOptions(screen.getByLabelText('کیف پول پرداخت'), 'platform')
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
}

describe('Penpot routes with canonical integration ENABLED', () => {
  it('manages delegated inventory by platform UUID and drops stale access after revocation', async () => {
    const original = globalThis.fetch
    const canonicalId = 'f07b9500-414e-4000-8000-000000000002'
    const legacyId = '11111111-1111-4111-8111-111111111111'
    let revoked = false
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } }))
      if (url.endsWith('/servers')) return json([{ id: legacyId, platformServerId: canonicalId, name: 'leaseweb-test', status: 'active', datacenter: 'Leaseweb', cpu: '2', ram: '4 GB', disk: '40 GB', power: { canPowerOn: false, canPowerOff: false } }])
      if (url.endsWith(`/platform/servers/${canonicalId}`)) return revoked
        ? Promise.resolve(new Response(JSON.stringify({ message: 'دسترسی لغو شد' }), { status: 404, headers: { 'content-type': 'application/json' } }))
        : json({ server: { server_id: canonicalId, display_name: 'leaseweb-test', state: 'running' }, operations: ['view'], credentialsAllowed: false })
      if (url.endsWith(`/platform/servers/${canonicalId}/operations`)) return json([])
      return original(url, init)
    }))
    const user = userEvent.setup()
    open('/servers')
    await user.click(await screen.findByRole('button', { name: 'مدیریت و نتیجه عملیات' }))
    await screen.findByRole('heading', { name: 'مدیریت leaseweb-test' })
    expect(calls.some(call => call.url.endsWith(`/platform/servers/${canonicalId}`))).toBe(true)
    expect(calls.some(call => call.url.includes(legacyId))).toBe(false)
    expect(screen.queryByRole('button', { name: 'دریافت رمز یک‌بارمصرف' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'حذف سرور' })).toBeNull()
    revoked = true
    await user.click(screen.getByRole('button', { name: 'تازه‌سازی وضعیت' }))
    await screen.findByText('دسترسی لغو شد')
    expect(screen.queryByRole('heading', { name: 'مدیریت leaseweb-test' })).toBeNull()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('drops a prepared action when access is reduced to read-only without a 404', async () => {
    const original = globalThis.fetch
    const canonicalId = 'f07b9500-414e-4000-8000-000000000002'
    let readOnly = false
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/servers')) return json([{ id: canonicalId, platformServerId: canonicalId, name: 'leaseweb-test', status: 'active', datacenter: 'Leaseweb', power: { canPowerOn: false, canPowerOff: false } }])
      if (url.endsWith(`/platform/servers/${canonicalId}`)) return json({ server: { server_id: canonicalId, display_name: 'leaseweb-test', state: 'stopped' }, operations: readOnly ? ['view'] : ['start'], credentialsAllowed: false })
      if (url.endsWith(`/platform/servers/${canonicalId}/operations`)) return json([])
      return original(url, init)
    }))
    const user = userEvent.setup()
    open('/servers')
    await user.click(await screen.findByRole('button', { name: 'مدیریت و نتیجه عملیات' }))
    await user.click(await screen.findByRole('button', { name: 'روشن کردن' }))
    expect(screen.getByRole('region', { name: 'تأیید عملیات سرور' })).toBeTruthy()
    readOnly = true
    await user.click(screen.getByRole('button', { name: 'تازه‌سازی وضعیت' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'تأیید عملیات سرور' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'روشن کردن' })).toBeNull()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('preserves both login methods and Google entry while changing the auth layout', async () => {
    const user = userEvent.setup()
    open('/login')
    expect(await screen.findByRole('button', { name: /ورود با حساب گوگل/ })).toBeTruthy()
    expect(screen.getByLabelText('آدرس ایمیل')).toBeTruthy()
    expect(document.querySelector('input[type="password"]')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: /شماره همراه/ }))
    expect(screen.getByLabelText('شماره همراه')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ارسال کد پیامکی' })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: /ایمیل و رمز عبور/ }))
    expect(screen.getByRole('button', { name: /ورود با حساب گوگل/ })).toBeTruthy()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('keeps errors and login controls available when auth content grows', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/auth/login/start')
      ? Promise.resolve(new Response(JSON.stringify({ message: 'خطای آزمایشی ورود' }), { status: 400, headers: { 'content-type': 'application/json' } })) : original(url, init)))
    const user = userEvent.setup()
    open('/login')
    await user.type(await screen.findByLabelText('آدرس ایمیل'), 'preview@example.test')
    await user.type(document.querySelector('input[type="password"]')!, 'fixture-password-only')
    await user.click(screen.getByRole('button', { name: 'ورود به حساب', exact: true }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ورود به حساب', exact: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: /ورود با حساب گوگل/ })).toBeTruthy()
  })

  it('opens the account dropdown and closes it after selecting a destination', async () => {
    const user = userEvent.setup()
    open('/dashboard')
    const avatar = await screen.findByRole('button', { name: 'منوی کاربری' })
    expect(avatar.getAttribute('aria-expanded')).toBe('false')
    await user.click(avatar)
    expect(avatar.getAttribute('aria-expanded')).toBe('true')
    const menu = document.getElementById(avatar.getAttribute('aria-controls')!)!
    expect(menu.classList.contains('popover--profile')).toBe(true)
    expect(within(menu).getByRole('link', { name: 'نشست‌ها' }).getAttribute('href')).toBe('/sessions')
    await user.click(within(menu).getByRole('link', { name: 'نشست‌ها' }))
    await screen.findByRole('heading', { level: 1, name: /نشست/ })
    expect(document.getElementById('profile-menu')).toBeNull()
    expect(avatar.getAttribute('aria-expanded')).toBe('false')
  })

  it('isolates landing typography and buttons from reusable console components', () => {
    const css = readFileSync('src/public.css', 'utf8')
    expect(css).not.toMatch(/(^|[},])\s*\.section-heading\b/)
    expect(css).not.toMatch(/(^|[},])\s*\.button\b/)
    expect(css).toContain('.landing-section-heading')
  })

  it('keeps dashboard identity for unlinked accounts instead of replacing it with pairing UI', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/integration/status')
      ? Promise.resolve(new Response(JSON.stringify({ data: { enabled: true, linked: false } }), { headers: { 'content-type': 'application/json' } }))
      : original(url, init)))
    open('/dashboard')
    expect(await screen.findByRole('heading', { level: 1, name: 'خوش آمدید 👋' })).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'تنظیمات اتصال تلگرام' })).toBeTruthy()
    expect(screen.queryByLabelText('کد اتصال یک‌بارمصرف')).toBeNull()
  })

  it('distinguishes unsupported official invoices from an empty or fabricated invoice list', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/invoices')
      ? Promise.resolve(new Response(JSON.stringify({ message: 'صدور فاکتور رسمی هنوز ارائه نشده است.' }), { status: 501, headers: { 'content-type': 'application/json' } }))
      : original(url, init)))
    open('/invoices')
    expect(await screen.findByRole('heading', { name: 'فاکتور رسمی در سرویس مرجع ارائه نشده است' })).toBeTruthy()
    expect(screen.queryByText('فاکتوری یافت نشد')).toBeNull()
  })
  it('keeps the empty charge-request action connected to the shared wallet', async () => {
    open('/charge-requests')
    await screen.findByRole('heading', { name: 'درخواست شارژی یافت نشد' })
    const card = within(document.querySelector('.resource-empty-card') as HTMLElement)
    expect(card.getByRole('link', { name: 'شارژ کیف پول' }).getAttribute('href')).toBe('/wallet')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })
  it.each([
    ['/dashboard', 'خوش آمدید 👋'], ['/wallet', 'کیف پول 💰'], ['/invoices', 'فاکتورها 📄'],
    ['/charge-requests', 'درخواست‌های شارژ 💳'], ['/servers', 'مدیریت سرورها'], ['/servers/create', 'ایجاد سرور جدید'],
    ['/tickets', 'تیکت‌ها'], ['/ips', 'مدیریت آی‌پی‌ها'], ['/traffic-packages', 'بسته ترافیک 📦'],
    ['/domains', 'مدیریت دامنه‌ها'], ['/domains/register', 'ثبت دامنه جدید'],
    ['/profile/update', 'پروفایل کاربری 👤'], ['/sessions', 'نشست‌های فعال 🔐'], ['/settings', 'تنظیمات'],
  ])('%s retains its own page instead of the shared console', async (path, title) => {
    open(path)
    expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeTruthy()
    expect(screen.queryByText('پلتفرم مشترک سایت و تلگرام')).toBeNull()
  })

  it('keeps long wallet history intact rather than truncating it to fit the viewport', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/wallets/transactions')
      ? Promise.resolve(new Response(JSON.stringify({ data: Array.from({ length: 40 }, (_, index) => ({
        id: `history-${index}`, description: `Fixture transaction ${index + 1}`, wallet: 'shared',
        amount: 100, date: new Date().toISOString(), status: 'success',
      })) }), { headers: { 'content-type': 'application/json' } })) : original(url, init)))
    open('/wallet')
    await screen.findByText('Fixture transaction 40')
    const history = within(document.querySelector('.wallet-transactions') as HTMLElement)
    expect(history.getAllByRole('row')).toHaveLength(41)
    expect(history.getByRole('button', { name: 'دانلود' }).hasAttribute('disabled')).toBe(false)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('keeps expanded profile fields and the save action available in the shared layout', async () => {
    const user = userEvent.setup()
    open('/profile/update')
    await user.click(await screen.findByRole('switch', { name: 'غیرفعال' }))
    expect(screen.getByLabelText('نام شرکت')).toBeTruthy()
    expect(screen.getByLabelText('کد اقتصادی')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ذخیره تغییرات' })).toBeTruthy()
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  })

  it('keeps the public landing accessible to an authenticated user', async () => {
    open('/')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('ایده‌های بزرگ شما')
    expect(await screen.findByRole('link', { name: 'ورود به پنل مدیریت' })).toBeTruthy()
    const cta = within(document.querySelector('.landing-cta') as HTMLElement)
    expect(cta.getByRole('link', { name: 'ایجاد سرور جدید' }).getAttribute('href')).toBe('/servers/create')
    expect(cta.getByRole('link', { name: 'ورود به پنل' }).getAttribute('href')).toBe('/dashboard')
    expect(document.querySelectorAll('a[href="/login"],a[href="/register"]')).toHaveLength(0)
  })

  it('keeps the end-of-landing CTA correct for guests as well', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/auth/me')
      ? Promise.resolve(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })) : original(url, init)))
    open('/')
    const cta = within(document.querySelector('.landing-cta') as HTMLElement)
    expect(cta.getByRole('link', { name: 'ساخت حساب' }).getAttribute('href')).toBe('/register')
    expect(cta.getByRole('link', { name: 'ورود به پنل' }).getAttribute('href')).toBe('/login')
  })

  it('uses the Penpot brand in both the landing and console sidebar', async () => {
    const view = open('/')
    expect(screen.getAllByRole('link', { name: 'سرورهاب' })).toHaveLength(2)
    view.unmount()
    open('/dashboard')
    await screen.findByRole('heading', { name: 'خوش آمدید 👋' })
    expect(document.querySelector('.sidebar__brand strong')?.textContent).toBe('سرورهاب')
    expect(screen.queryByText('کلود سرور')).toBeNull()
  })

  it('filters wallet history by the chosen period without relabelling foreign amounts as toman', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/wallets/transactions')
      ? Promise.resolve(new Response(JSON.stringify({ data: [
        { id: 'recent', description: 'native USD entry', wallet: 'shared', amount: 500, formattedAmount: '+5.00 USD', date: new Date().toISOString(), status: 'success' },
        { id: 'older', description: 'older entry', wallet: 'shared', amount: 1000, date: new Date(Date.now() - 48 * 3600000).toISOString(), status: 'success' },
      ] }), { headers: { 'content-type': 'application/json' } }))
      : original(url, init)))
    const user = userEvent.setup()
    open('/wallet')
    expect(await screen.findByText('+5.00 USD')).toBeTruthy()
    expect(screen.queryByText('older entry')).toBeNull()
    await user.click(screen.getByRole('button', { name: '۷ روز اخیر' }))
    expect(await screen.findByText('older entry')).toBeTruthy()
  })

  it('shows linking only under settings, with a confirmed revoke action', async () => {
    const user = userEvent.setup()
    open('/settings/telegram')
    await user.click(await screen.findByRole('button', { name: 'قطع اتصال (Revoke)' }))
    expect(requests.filter(r => r.path === '/integration/disconnect')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'تأیید قطع اتصال' }))
    await waitFor(() => expect(requests.filter(r => r.path === '/integration/disconnect')).toHaveLength(1))
    expect(screen.queryByText('خرید با تعرفه مشترک ربات')).toBeNull()
  })

  it('walks all six purchase steps, fetches real OS options and only submits on final confirmation', async () => {
    const user = userEvent.setup()
    open('/servers/create')
    await screen.findByRole('button', { name: /Hetzner/ })
    expect((screen.getByRole('button', { name: 'مرحله بعد' }) as HTMLButtonElement).disabled).toBe(true)
    await reviewOrder(user)
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0)
    // Going back never submits, and the selected OS/wallet survives.
    await user.click(screen.getByRole('button', { name: 'مرحله قبل' }))
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    await user.click(screen.getByRole('button', { name: 'تایید و ایجاد سرور' }))
    await waitFor(() => expect(requests.filter(r => r.path === '/platform/orders')).toHaveLength(1))
    const order = requests.find(r => r.path === '/platform/orders')!
    expect(order.body).toEqual({ offerId, image: 'ubuntu-24.04', expectedMinor: 4, expectedCurrency: 'USD' })
    expect(order.key).toBeTruthy()
    expect(requests.some(r => r.method === 'POST' && r.path === '/servers')).toBe(false)
    expect(await screen.findByRole('heading', { name: 'مدیریت سرورها', level: 1 })).toBeTruthy()
  })

  it('reuses the same purchase key after an uncertain response instead of creating a new command', async () => {
    const original = globalThis.fetch
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await original(url, init)
      if (url.endsWith('/platform/orders') && attempts++ === 0) return new Response(JSON.stringify({ message: 'نتیجه درخواست نامشخص است.' }), { status: 502, headers: { 'content-type': 'application/json' } })
      return response
    }))
    const user = userEvent.setup()
    open('/servers/create')
    await reviewOrder(user)
    await user.click(screen.getByRole('button', { name: 'تایید و ایجاد سرور' }))
    await screen.findByText('نتیجه درخواست نامشخص است.')
    await user.click(screen.getByRole('button', { name: 'تایید و ایجاد سرور' }))
    await waitFor(() => expect(requests.filter(r => r.path === '/platform/orders')).toHaveLength(2))
    const orders = requests.filter(r => r.path === '/platform/orders')
    expect(orders[0].key).toBe(orders[1].key)
    expect(orders[0].body).toEqual(orders[1].body)
  })
})
