import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'react-toastify'
import { ServerDetailsPage } from '../src/pages/ServerDetailsPage'
import { ToastProvider } from '../src/components/ui/Toast'
import { OneTimePassword } from '../src/components/servers/ServerManagementControls'
// @ts-expect-error Synthetic JS fixtures shared with the loopback design preview.
import { detailServer, serverUxFixture } from './server-management-fixtures.mjs'
import type { ServerDetail } from '../src/lib/serverManagement'

let requests: Array<{ path: string; method: string; body: unknown; key?: string }>
let detail: ServerDetail
beforeEach(() => {
  requests = []
  detail = structuredClone(detailServer)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/api', '')
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get('idempotency-key') ?? undefined })
    return Response.json(path.includes('/management') && (!init?.method || init.method === 'GET')
      ? { data: detail } : serverUxFixture(path.split('?')[0]))
  }))
})
afterEach(() => toast.dismiss())
function open(tab = 'overview') {
  return render(<MemoryRouter initialEntries={[`/servers/${detailServer.id}?tab=${tab}`]}><ToastProvider><Routes><Route path="/servers/:id" element={<ServerDetailsPage />} /></Routes></ToastProvider></MemoryRouter>)
}
describe('customer server management UI', () => {
  it('shows real resource fields and keeps provider and customer price separate', async () => {
    open()
    await screen.findByText('اطلاعات فنی')
    expect(screen.getByText('preview-project:1001')).toBeTruthy()
    expect(screen.getByText('صورت‌حساب و کیف پول')).toBeTruthy()
    expect(screen.getByText(/نرخ خرید ثبت‌شدهٔ ارائه‌دهنده/)).toBeTruthy()
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })
  it('requires the exact server name and explicit acknowledgment before a destructive request', async () => {
    const user = userEvent.setup(), success = vi.spyOn(toast, 'success')
    open()
    await user.click(await screen.findByRole('button', { name: 'حذف دائمی سرور' }))
    const confirm = screen.getByRole('button', { name: 'تأیید حذف دائمی سرور' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await user.type(screen.getByRole('textbox'), 'wrong-server')
    await user.click(screen.getByRole('checkbox'))
    expect(confirm.disabled).toBe(true)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
    await user.clear(screen.getByRole('textbox')); await user.type(screen.getByRole('textbox'), detailServer.name)
    await user.click(confirm)
    await waitFor(() => expect(requests.filter(request => request.method === 'POST')).toHaveLength(1))
    expect(requests.find(request => request.method === 'POST')).toMatchObject({ body: { action: 'delete', hostname: detailServer.name, confirm: true }, key: expect.any(String) })
    expect(success).not.toHaveBeenCalled(); success.mockRestore()
  })
  it('renders separate soft and forced power actions and leaves existing password retrieval unavailable', async () => {
    open('operations')
    expect(await screen.findByRole('button', { name: 'خاموشی نرم (ACPI)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'خاموشی اجباری' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'سیستم‌عامل و دسترسی' }))
    expect(await screen.findByText(/رمز فعلی قابل بازیابی نیست/)).toBeTruthy()
    expect(screen.queryByText('نمایش رمز فعلی')).toBeNull()
  })
  it('explains an unresolved shutdown beside both controls and rechecks eligibility without submitting an action', async () => {
    detail.accessEligibility = { rebuild: 'operation_pending', resetPassword: 'operation_pending' }
    detail.operations = [{ id: 'pending-shutdown', action: 'power_off', status: 'outcome_unknown', actionId: null,
      createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', completedAt: null, message: null }]
    open('access')
    const password = await screen.findByRole<HTMLButtonElement>('button', { name: 'بازنشانی رمز عبور' })
    const images = screen.getByRole<HTMLSelectElement>('combobox', { name: 'تصویر سیستم‌عامل مجاز' })
    expect(password.disabled).toBe(true)
    expect(images.disabled).toBe(true)
    expect(document.getElementById(password.getAttribute('aria-describedby')!)?.textContent).toContain('خاموشی اجباری')
    expect(document.getElementById(images.getAttribute('aria-describedby')!)?.textContent).toContain('خاموشی اجباری')
    expect(requests.some(request => request.path.endsWith('/images'))).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: 'مشاهدهٔ عملیات' })[0])
    expect(screen.getByText('تاریخچه عملیات')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'سیستم‌عامل و دسترسی' }))
    detail = { ...detail, accessEligibility: { rebuild: null, resetPassword: null }, operations: [] }
    fireEvent.click(screen.getAllByRole('button', { name: 'بررسی دوبارهٔ وضعیت' })[0])
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'بازنشانی رمز عبور' }).disabled).toBe(false))
    await waitFor(() => expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(false))
    expect(requests.some(request => request.path.endsWith('/management?refresh=1'))).toBe(true)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })
  it('blocks only rebuild when protection is on and retains the data-loss confirmation when it is off', async () => {
    detail.accessEligibility = { rebuild: 'rebuild_protected', resetPassword: null }
    open('access')
    expect(await screen.findByText(/حفاظت نصب مجدد .* فعال است/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'بازنشانی رمز عبور' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'مشاهدهٔ حفاظت سرور' }))
    expect(screen.getByRole('button', { name: 'تغییر حفاظت Rebuild' })).toBeTruthy()
    detail = { ...detail, accessEligibility: { rebuild: null, resetPassword: null } }
    fireEvent.click(screen.getByRole('button', { name: 'بروزرسانی' }))
    fireEvent.click(screen.getByRole('button', { name: 'سیستم‌عامل و دسترسی' }))
    await screen.findByRole('option', { name: 'Ubuntu 24.04' })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'نصب مجدد و حذف داده‌ها' }))
    expect(screen.getByText(/این عملیات داده‌های دیسک سرور را از بین می‌برد/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'تأیید نصب مجدد سیستم‌عامل' }).disabled).toBe(true)
  })
  it('offers support for provider access denial and does not promise a password reset', async () => {
    detail.accessEligibility = { rebuild: 'provider_access_denied', resetPassword: 'provider_access_denied' }
    detail.providerAvailable = false
    open('access')
    expect(await screen.findAllByText(/دسترسی به سرور در پروژهٔ ارائه‌دهنده تأیید نشد/)).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'پشتیبانی' })[0].getAttribute('href')).toBe('/tickets')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'بازنشانی رمز عبور' }).disabled).toBe(true)
    expect(screen.queryByText(/می‌توانید رمز را بازنشانی کنید/)).toBeNull()
  })
  it('honors individual capabilities when the response predates the eligibility fields', async () => {
    detail.capabilities.resetPassword = false
    open('access')
    expect(await screen.findByText(/از این عملیات پشتیبانی نمی‌کند/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'بازنشانی رمز عبور' }).disabled).toBe(true)
    await waitFor(() => expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(false))
  })
  it('rechecks the blocking shutdown from Resize, then offers a plan and price after confirmed power off', async () => {
    const shutdown = { id: 'shutdown-27', action: 'power_off', status: 'outcome_unknown', actionId: 27,
      createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', completedAt: null, message: null } as const
    detail.operations = [shutdown]
    detail.resizeBlock = 'operation_pending'
    const fallback = vi.mocked(fetch).getMockImplementation()!
    let checkCount = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.endsWith('/operations/shutdown-27/recheck')) {
        expect(init?.method).toBe('POST')
        if (++checkCount === 1) return Response.json({ data: { operation: shutdown, checkFailed: false } })
        const confirmed = { ...shutdown, status: 'confirmed' as const, completedAt: new Date().toISOString() }
        detail = { ...detail, providerState: 'suspended', resizeBlock: null, operations: [confirmed] }
        return Response.json({ data: { operation: confirmed, checkFailed: false } })
      }
      if (path.endsWith('/resize-preview')) return Response.json({ data: { quoteId: 'fixture', upgradeDisk: false,
        currentPriceRial: 20000, priceRial: 30000, immediateChargeRial: 0, period: 'HOURLY', expiresAt: new Date(Date.now() + 60_000).toISOString() } })
      return fallback(url, init)
    })
    open('resize')
    expect(await screen.findByText(/تا روشن شدن نتیجهٔ «خاموشی اجباری»/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /CX33/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'رفتن به عملیات برق' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'مشاهدهٔ عملیات' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'خاموشی اجباری' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'بررسی نتیجهٔ عملیات' }))
    expect(await screen.findByText(/نتیجه هنوز نهایی نشده است/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'تغییر پلن' }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'بررسی نتیجهٔ عملیات' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'بررسی نتیجهٔ عملیات' }))
    expect(await screen.findByText('ارائه‌دهنده انجام عملیات را تأیید کرد.')).toBeTruthy()
    const plan = await screen.findByRole<HTMLButtonElement>('button', { name: /CX33/ })
    await waitFor(() => expect(plan.disabled).toBe(false))
    fireEvent.click(plan)
    fireEvent.click(screen.getByRole('button', { name: 'بررسی قیمت و محدودیت‌ها' }))
    expect(await screen.findByText(/قیمت قبل/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'تأیید تغییر پلن' }).disabled).toBe(false)
    expect(checkCount).toBe(2)
  })
  it('uses actual metric series and keeps unsupported shared-project mutations out of the UI', async () => {
    open('monitoring')
    expect(await screen.findByRole('img', { name: /نمودار CPU/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'کنسول و تنظیمات' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot، Backup و Volume' }))
    expect(await screen.findByText(/ساخت و بازیابی Snapshot.*هنوز/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ساخت اسنپ‌شات' })).toBeNull()
  })
  it('routes a console blocked by a prior operation to the operation history', async () => {
    detail.capabilities.console = true
    detail.consoleBlock = 'operation_pending'
    detail.operations = [{ id: 'pending-shutdown', action: 'power_off', status: 'outcome_unknown', actionId: null,
      createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', completedAt: null, message: null }]
    open('console')
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'ایجاد نشست موقت' })).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'پایان نشست' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'مشاهدهٔ عملیات' }))
    expect(screen.getByRole('button', { name: 'بررسی نتیجهٔ عملیات' })).toBeTruthy()
  })
  it('does not reveal a delayed one-time credential after the tab becomes hidden', async () => {
    let resolve: (value: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const close = vi.fn()
    render(<OneTimePassword server={detailServer} operationId="fixture-operation" onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: 'دریافت امن رمز' }))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => resolve(Response.json({ data: { password: 'Fixture-no-hidden-reveal!', expiresAt: new Date(Date.now() + 60000).toISOString() } })))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(screen.queryByText('Fixture-no-hidden-reveal!')).toBeNull()
    vi.restoreAllMocks()
  })
})
