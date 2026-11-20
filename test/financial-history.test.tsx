import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ChargeRequestsPage, InvoicesPage } from '../src/pages/FinancePages'

vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-user' } }) }))

it.each([
  { path: '/invoices', prefix: 'INV', status: 'overdue', label: 'سررسیدگذشته', page: <InvoicesPage /> },
  { path: '/charge-requests', prefix: 'PAY', status: 'processing', label: 'در حال پردازش', page: <ChargeRequestsPage /> },
])('filters $path before the initial page and supports previous and next pages', async ({ path, prefix, status, label, page }) => {
  const calls: URLSearchParams[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const urlParts = new URL(url, 'https://fixture.test')
    expect(urlParts.pathname).toBe('/api' + path)
    calls.push(urlParts.searchParams)
    const offset = Number(urlParts.searchParams.get('offset'))
    const filtered = urlParts.searchParams.get('status') === status || urlParts.searchParams.get('search') === prefix.toLowerCase() + '-100'
    const old = filtered || offset === 50
    return Response.json({
      data: [{ id: 'fixture-id', number: prefix + (old ? '-100' : '-150'), status: old ? status : 'pending', amount: 100, date: '2026-11-18T00:00:00Z' }],
      pagination: { offset, nextOffset: old ? null : 50 },
    })
  }))
  render(<MemoryRouter>{page}</MemoryRouter>)
  const user = userEvent.setup()
  expect(await screen.findByText(prefix + '-150')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }))
  expect(await screen.findByText(prefix + '-100')).toBeTruthy()
  expect(within(screen.getByRole('table')).getByText(label)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'صفحهٔ قبل' }))
  expect(await screen.findByText(prefix + '-150')).toBeTruthy()
  await user.selectOptions(screen.getByRole('combobox', { name: 'وضعیت' }), status)
  expect(await screen.findByText(prefix + '-100')).toBeTruthy()
  await user.selectOptions(screen.getByRole('combobox', { name: 'وضعیت' }), 'all')
  await user.type(screen.getByRole('textbox', { name: 'جستجو' }), prefix.toLowerCase() + '-۱۰۰')
  await waitFor(() => expect(calls.some(params => params.get('search') === prefix.toLowerCase() + '-100')).toBe(true))
  expect(await screen.findByText(prefix + '-100')).toBeTruthy()
})
