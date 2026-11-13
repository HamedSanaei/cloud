import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'
import { AuthProvider } from '../src/auth/AuthContext'
import { ToastProvider } from '../src/components/ui/Toast'
import { checkoutFixture, serverId } from './fixtures.mjs'

let requests: Array<{ path: string; method: string; body: Record<string, unknown>; key?: string }>, allowed = true
beforeEach(() => {
  allowed = true; requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'https://example.test').pathname.replace(/^\/api/, ''), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ path, method, body, key: (init?.headers as Record<string, string>)?.['idempotency-key'] })
    let data = checkoutFixture(path)
    if (path === '/admin/settings/capabilities') data = { data: { ...data.data, allowed } }
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
  it('requires exact user/wallet selection and reauthentication before a ledger request', async () => {
    open('/admin/settings/finance'); const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: 'شمارهٔ موبایل یا ایمیل کامل' }), 'customer@example.test')
    await user.click(screen.getByRole('button', { name: 'جست‌وجوی حساب' }))
    await user.click(await screen.findByRole('button', { name: /کاربر آزمایشی.*customer@example.test/ }))
    await user.type(screen.getByRole('textbox', { name: 'مبلغ دقیق (ریال)' }), '500000')
    await user.type(screen.getByRole('textbox', { name: 'علت و توضیح اجباری' }), 'اصلاح آزمایشی حساب کاربری')
    await user.type(screen.getByRole('textbox', { name: 'شناسهٔ پیگیری / تیکت' }), 'TEST-9')
    await user.click(screen.getByRole('button', { name: 'بازبینی و تأیید تعدیل' }))
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0)
    await user.type(screen.getByLabelText('رمز عبور فعلی مدیر'), 'Fixture-only-password!')
    await user.type(screen.getByLabelText('کد برنامهٔ احراز هویت'), '123456')
    await user.click(screen.getByRole('button', { name: 'تأیید و اجرا' }))
    await screen.findByText(/عملیات fixture-operation ثبت شد/)
    const mutation = requests.filter(r => r.path === '/admin/settings/finance/adjustments' && r.method === 'POST')
    expect(mutation).toHaveLength(1); expect(mutation[0]!.body).toMatchObject({ amountRial: 500000, direction: 'credit', reason: 'اصلاح آزمایشی حساب کاربری', reference: 'TEST-9' })
    expect(mutation[0]!.key).toBeTruthy()
  })
  it('shows the restore impact and requires a typed phrase before step-up, without nested dialogs', async () => {
    open('/admin/settings/backups'); const user = userEvent.setup()
    const row = (await screen.findByText(serverId)).closest('section')!
    await user.click(within(row).getByRole('button', { name: 'جزئیات / بازیابی' }))
    expect(screen.getByText('خلاصهٔ تغییرات پیش از بازیابی')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'درخواست بازیابی کنترل‌شده' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await user.type(screen.getByLabelText('برای ادامه عبارت RESTORE DATABASE را وارد کنید'), 'RESTORE DATABASE')
    await user.click(button)
    expect(screen.queryByText('جزئیات و کنترل بازیابی')).toBeNull()
    expect(screen.getByText('تأیید امن عملیات')).toBeTruthy()
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(0)
  })
})
