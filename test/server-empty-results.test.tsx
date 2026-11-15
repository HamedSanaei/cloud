import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ServersPage } from '../src/pages/InfrastructurePages'
import { ToastProvider } from '../src/components/ui/Toast'
// @ts-expect-error Shared synthetic fixture, never a real account/API.
import { fixture } from './fixtures.mjs'

vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'fixture-user', role: 'user' } }) }))

const history = [
  { id: 'deleted-55-a', name: 'Past server A', status: 'inactive', lifecycle: 'terminated', datacenter: 'Hetzner', power: {} },
  { id: 'deleted-55-b', name: 'Past server B', status: 'inactive', lifecycle: 'terminated', datacenter: 'Leaseweb', power: {} },
]
let rows: Record<string, unknown>[] = history
let fail = false
beforeEach(() => {
  rows = history; fail = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace(/^\/api/, '').split('?')[0]
    if (path === '/servers') {
      if (fail) throw new Error('fixture unavailable')
      return Response.json({ data: rows })
    }
    return Response.json(fixture(path))
  }))
})
const open = () => render(<MemoryRouter><ToastProvider><ServersPage /></ToastProvider></MemoryRouter>)
const emptyCard = () => within(document.querySelector('.resource-empty-card') as HTMLElement)

describe('server list empty states', () => {
  it('filters failed lifecycle and tracking-only records while preserving search, datacenter and reset', async () => {
    const user = userEvent.setup()
    rows = [
      ...history,
      { ...history[0], id: 'ready-74', name: 'Ready server', status: 'active', lifecycle: 'ready' },
      { ...history[0], id: 'failed-74', name: 'Failed order', status: 'building', lifecycle: 'failed' },
      { ...history[1], id: 'tracking-failed-74', name: 'Tracking failed order', status: 'building', lifecycle: undefined,
        tracking: { source: 'site', reference: 'tracking-failed-74', state: 'failed' } },
      { ...history[0], id: 'review-74', name: 'Under review', status: 'building', lifecycle: 'outcome_unknown' },
      { ...history[0], id: 'deletion-failed-74', name: 'Deletion failed', lifecycle: 'delete_failed' },
    ]
    open()
    await screen.findByRole('cell', { name: 'Failed order', exact: true })
    const nameCell = (name: string) => screen.queryByRole('cell', { name, exact: true })
    const status = screen.getByRole('combobox', { name: 'وضعیت' })
    await user.selectOptions(status, 'failed')
    expect(nameCell('Failed order')).toBeTruthy()
    expect(nameCell('Tracking failed order')).toBeTruthy()
    for (const name of ['Ready server', 'Past server A', 'Past server B', 'Under review', 'Deletion failed']) expect(nameCell(name)).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'دیتاسنتر' }), 'Leaseweb')
    expect(nameCell('Tracking failed order')).toBeTruthy()
    expect(nameCell('Failed order')).toBeNull()
    await user.type(screen.getByRole('textbox', { name: 'جستجو' }), 'no-match')
    expect(emptyCard().getByText('سروری با این جستجو یا فیلترها یافت نشد')).toBeTruthy()
    await user.click(emptyCard().getByRole('button', { name: 'پاک کردن فیلترها' }))
    expect(nameCell('Failed order')).toBeTruthy()
    expect(nameCell('Ready server')).toBeTruthy()
    expect((status as HTMLSelectElement).value).toBe('all')
    await user.selectOptions(status, 'active')
    expect(nameCell('Ready server')).toBeTruthy()
    expect(nameCell('Failed order')).toBeNull()
    await user.selectOptions(status, 'inactive')
    expect(screen.getByText('Past server A')).toBeTruthy()
    expect(nameCell('Tracking failed order')).toBeNull()
  })

  it('shows the existing empty-results message when no failed orders match', async () => {
    const user = userEvent.setup()
    open()
    await screen.findByText('Past server A')
    await user.selectOptions(screen.getByRole('combobox', { name: 'وضعیت' }), 'failed')
    expect(emptyCard().getByText('سروری با این جستجو یا فیلترها یافت نشد')).toBeTruthy()
    expect(screen.queryByText('هنوز سروری نساخته‌اید')).toBeNull()
  })

  it.each(['status', 'search', 'combined'])('shows empty results for %s and resets every filter to restore history', async mode => {
    const user = userEvent.setup()
    open()
    await screen.findByText('Past server A')
    if (mode !== 'search') await user.selectOptions(screen.getByRole('combobox', { name: 'وضعیت' }), 'active')
    if (mode !== 'status') await user.type(screen.getByRole('textbox', { name: 'جستجو' }), 'no-match')
    if (mode === 'combined') await user.selectOptions(screen.getByRole('combobox', { name: 'دیتاسنتر' }), 'Leaseweb')
    expect(emptyCard().getByText('سروری با این جستجو یا فیلترها یافت نشد')).toBeTruthy()
    expect(screen.queryByText('هنوز سروری نساخته‌اید')).toBeNull()
    expect(screen.queryByRole('link', { name: 'ساخت اولین سرور' })).toBeNull()
    await user.click(emptyCard().getByRole('button', { name: 'پاک کردن فیلترها' }))
    expect(screen.getByText('Past server A')).toBeTruthy()
    expect(screen.getByText('Past server B')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'جستجو' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('combobox', { name: 'وضعیت' }) as HTMLSelectElement).value).toBe('all')
    expect((screen.getByRole('combobox', { name: 'دیتاسنتر' }) as HTMLSelectElement).value).toBe('all')
  })

  it('reserves the first-server message and creation link for an account without records', async () => {
    rows = []
    open()
    await screen.findByText('هنوز سروری نساخته‌اید')
    expect(emptyCard().getByRole('link', { name: 'ساخت اولین سرور' }).getAttribute('href')).toBe('/servers/create')
    expect(emptyCard().queryByRole('button', { name: 'پاک کردن فیلترها' })).toBeNull()
  })

  it('does not present a failed request as a first-server or empty-results state', async () => {
    fail = true
    open()
    await screen.findByText('دریافت وضعیت سرورها ناموفق بود؛ درخواست جدیدی ثبت نکنید.')
    expect(screen.queryByText('هنوز سروری نساخته‌اید')).toBeNull()
    expect(screen.queryByText('سروری با این جستجو یا فیلترها یافت نشد')).toBeNull()
  })
})
