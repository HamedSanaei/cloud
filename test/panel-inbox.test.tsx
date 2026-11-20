import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ToastProvider } from '../src/components/ui/Toast'
import { NotificationCenter } from '../src/components/layout/NotificationCenter'
import { TicketsPage } from '../src/pages/TicketsPage'

it('offers to read all when only an older hidden notification is unread and announces both bell states', async () => {
  let unreadCount = 1
  const calls: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/notifications/read')) {
      calls.push(JSON.parse(String(options?.body)))
      unreadCount = 0
      return Response.json({ data: { ok: true } })
    }
    return Response.json({ unreadCount, data: Array.from({ length: 50 }, (_, index) => ({
      id: `notice-${index}`, title: `Visible notice ${index}`, read: true,
    })) })
  }))
  render(<MemoryRouter><ToastProvider><NotificationCenter userId="fixture" /></ToastProvider></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'اعلان‌ها، اعلان خوانده‌نشده دارید' }))
  await user.click(screen.getByRole('button', { name: 'خواندن همه' }))
  expect(await screen.findByRole('button', { name: 'اعلان‌ها', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'خواندن همه' })).toBeNull()
  expect(calls).toEqual([{ all: true }])
})

it('shows translated ticket cells, searches the server history and acknowledges the opened reply', async () => {
  let unread = true
  const calls: unknown[] = []
  const row = { id: 'fixture-ticket', title: 'Older ticket', status: 'answered', department: 'technical' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const { pathname, searchParams } = new URL(url, 'https://fixture.test')
    if (pathname.endsWith('/summary')) return Response.json({ data: { total: 51, answered: 1, unread: unread ? 1 : 0 } })
    if (pathname.endsWith('/read')) {
      unread = false
      calls.push(JSON.parse(String(options?.body)))
      return Response.json({ data: { ok: true } })
    }
    if (pathname.endsWith('/fixture-ticket')) return Response.json({ data: { ...row, unread,
      replies: [{ id: 'fixture-reply', read: !unread, body: 'Opened response', createdAt: '2026-11-19T12:00:00Z' }],
    } })
    return Response.json({ data: searchParams.get('status') === 'answered' ? [{ ...row, unread }]
      : [{ ...row, id: 'recent', title: 'Newer ticket', status: 'closed' }], pagination: { offset: 0, nextOffset: null } })
  }))
  render(<MemoryRouter><ToastProvider><TicketsPage /></ToastProvider></MemoryRouter>)
  const user = userEvent.setup()
  expect(await screen.findByRole('cell', { name: 'بسته شده' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'فنی' })).toBeTruthy()
  await user.selectOptions(screen.getByRole('combobox', { name: 'وضعیت' }), 'answered')
  expect(await screen.findByText('پاسخ خوانده‌نشده')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'مشاهده تیکت' }))
  expect(await screen.findByText('Opened response')).toBeTruthy()
  await waitFor(() => expect(screen.queryByText('پاسخ خوانده‌نشده')).toBeNull())
  expect(calls).toEqual([{ replyIds: ['fixture-reply'] }])
})
