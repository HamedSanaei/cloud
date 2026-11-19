import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'
import { AuthProvider } from '../src/auth/AuthContext'
import { ToastProvider } from '../src/components/ui/Toast'
import { checkoutFixture, serverId } from './fixtures.mjs'

let requests: Array<{ path: string; method: string; body: Record<string, unknown>; key?: string }>, allowed = true, encryptionReady = true
beforeEach(() => {
  allowed = true; encryptionReady = true; requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'https://example.test').pathname.replace(/^\/api/, ''), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ path, method, body, key: (init?.headers as Record<string, string>)?.['idempotency-key'] })
    let data = checkoutFixture(path)
    if (path === '/auth/me' && allowed) data = { data: { ...data.data, role: 'super_admin' } }
    if (path === '/admin/settings/capabilities') data = { data: { ...data.data, allowed, encryptionReady } }
    if (path === '/admin/settings/hetzner-margin') data = { data: { enabled: true, markupPercent: '25', markupFixedRial: 0,
      taxPercent: '0', version: '2026-11-19T12:00:00.000Z', updatedBy: null, history: [] } }
    if (path === '/admin/settings/admin-roles') data = { data: [{ id: serverId, email: 'operator@example.test', role: 'admin' }] }
    if (path === '/admin/settings/renewal-alerts') data = { data: [] }
    if (path === '/admin/settings/authorize') data = { data: { proof: 'f07b9500-414e-4000-8000-000000000004' } }
    if (path === '/admin/settings/finance/adjustments' && method === 'POST') data = { data: { id: 'fixture-operation', status: 'completed', afterRial: 5500000 } }
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  }))
})
function open(path: string) { return render(<MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></MemoryRouter>) }
describe('store administration routes and explicit confirmations', () => {
  it.each([['gateway', 'درگاه تاباپی'], ['logs', 'رویدادهای سیستم و Audit'], ['backups', 'پشتیبان‌گیری خصوصی PostgreSQL'], ['finance', 'یافتن دقیق حساب']])('opens its dedicated %s section', async (route, heading) => {
    open('/admin/settings/' + route)
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'بخش‌های تنظیمات فروشگاه' })).toBeTruthy()
  })
  it('does not fetch sensitive settings for a rejected non-admin account', async () => {
    allowed = false; open('/admin/settings/gateway')
    expect(await screen.findByText('دسترسی مدیریت مجاز نیست')).toBeTruthy()
    expect(requests.some(r => r.path === '/admin/settings/gateway')).toBe(false)
  })
  it('changes an explicitly selected manager role with credentials and confirmation', async () => {
    open('/admin/settings/admin-roles')
    const user = userEvent.setup()
    await screen.findByRole('option', { name: /operator@example.test/ })
    await user.selectOptions(screen.getByLabelText('حساب مدیر'), serverId)
    await user.type(screen.getByLabelText('رمز فعلی خودتان'), 'fixture-current-password')
    await user.type(screen.getByLabelText(/کد دومرحله‌ای خودتان/), '012345')
    await user.click(screen.getByLabelText('اعطای نقش سوپرادمین را تأیید می‌کنم'))
    await user.click(screen.getByRole('button', { name: 'ثبت تغییر نقش' }))
    expect(await screen.findByText('نقش مدیر به‌روزرسانی شد.')).toBeTruthy()
    expect(requests.find(request => request.path.endsWith('/admin-roles') && request.method === 'POST')?.body)
      .toEqual({ id: serverId, role: 'super_admin', password: 'fixture-current-password', totp: '012345', confirm: true })
  })
  it('renders admin sections even when the merchant encryption key is not configured', async () => {
    encryptionReady = false
    open('/admin/settings/logs')
    expect(await screen.findByRole('heading', { name: /Audit/ })).toBeTruthy()
    expect(await screen.findByText(/STORE_SECRET_KEY/)).toBeTruthy()
    expect(requests.some(r => r.path.startsWith('/admin/settings/logs'))).toBe(true)
  })
  it('uses the shared settings permission for margin and IPv4 tabs', async () => {
    encryptionReady = false
    open('/admin/settings/hetzner-margin')
    expect(await screen.findByRole('heading', { name: 'تنظیم سود سرورهای هتزنر' })).toBeTruthy()
    const tabs = within(screen.getByRole('navigation', { name: 'بخش‌های تنظیمات فروشگاه' }))
    for (const label of ['درگاه‌ها', 'شبکه و پراکسی خروجی', 'تعرفهٔ تعویض IPv4', 'پشتیبان‌گیری و بازیابی', 'نقش مدیران']) {
      expect(tabs.getByRole('link', { name: label })).toBeTruthy()
    }
    expect(requests.some(request => request.path === '/admin/settings/hetzner-margin')).toBe(true)
  })
  it('filters system logs by critical severity', async () => {
    open('/admin/settings/logs')
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('شدت'), 'critical')
    await user.click(screen.getByRole('button', { name: 'اعمال فیلتر' }))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/logs?level=critical'))).toBe(true)
  })
  it('updates the selected wallet without a second password or OTP', async () => {
    open('/admin/settings/finance'); const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: 'شمارهٔ موبایل یا ایمیل کامل' }), 'customer@example.test')
    await user.click(screen.getByRole('button', { name: 'جست‌وجوی حساب' }))
    await user.click(await screen.findByRole('button', { name: /کاربر آزمایشی.*customer@example.test/ }))
    await user.type(screen.getByRole('textbox', { name: 'مبلغ دقیق (ریال)' }), '500000')
    await user.type(screen.getByRole('textbox', { name: 'علت و توضیح اجباری' }), 'اصلاح آزمایشی حساب کاربری')
    await user.type(screen.getByRole('textbox', { name: 'شناسهٔ پیگیری / تیکت' }), 'TEST-9')
    await user.click(screen.getByRole('button', { name: 'بازبینی و تأیید تعدیل' }))
    await waitFor(() => expect(requests.some(r => r.path === '/admin/settings/finance/adjustments' && r.method === 'POST')).toBe(true))
    expect(screen.queryByLabelText('رمز عبور فعلی مدیر')).toBeNull()
    expect(screen.queryByLabelText('کد تأییدکننده شش‌رقمی')).toBeNull()
    const actionProof = requests.find(r => r.path === '/admin/settings/authorize')
    expect(actionProof?.body).not.toHaveProperty('password')
    expect(actionProof?.body).not.toHaveProperty('code')
    await screen.findByText(/عملیات fixture-operation ثبت شد/)
    const mutation = requests.filter(r => r.path === '/admin/settings/finance/adjustments' && r.method === 'POST')
    expect(mutation).toHaveLength(1); expect(mutation[0]!.body).toMatchObject({ amountRial: 500000, direction: 'credit', reason: 'اصلاح آزمایشی حساب کاربری', reference: 'TEST-9' })
    expect(mutation[0]!.key).toBeTruthy()
  })
  it('requires a typed restore confirmation but no extra password or OTP', async () => {
    open('/admin/settings/backups'); const user = userEvent.setup()
    const row = (await screen.findByText(serverId)).closest('section')!
    await user.click(within(row).getByRole('button', { name: 'جزئیات / بازیابی' }))
    expect(screen.getByText('خلاصهٔ تغییرات پیش از بازیابی')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'درخواست بازیابی کنترل‌شده' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.type(screen.getByLabelText('برای ادامه عبارت RESTORE DATABASE را وارد کنید'), 'RESTORE DATABASE')
    await user.click(button)
    expect(screen.queryByText('جزئیات و کنترل بازیابی')).toBeNull()
    await waitFor(() => expect(requests.some(r => r.path === '/admin/settings/restores' && r.method === 'POST')).toBe(true))
    expect(screen.queryByLabelText('رمز عبور فعلی مدیر')).toBeNull()
  })
})
