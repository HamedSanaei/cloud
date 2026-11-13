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

let requests: Array<{ path: string; method: string; body: unknown; key?: string }>
beforeEach(() => {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/api', '').split('?')[0]
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init?.headers).get('idempotency-key') ?? undefined })
    return Response.json(serverUxFixture(path))
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
  it('uses actual metric series and keeps unsupported shared-project mutations out of the UI', async () => {
    open('monitoring')
    expect(await screen.findByRole('img', { name: /نمودار CPU/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'کنسول و تنظیمات' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot، Backup و Volume' }))
    expect(await screen.findByText(/ساخت و بازیابی Snapshot.*هنوز/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ساخت اسنپ‌شات' })).toBeNull()
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
