import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IDBFactory } from 'fake-indexeddb'
import { NotificationCenter } from '../src/components/layout/NotificationCenter'
import { claimNotificationToasts } from '../src/lib/notificationDelivery'

const { getNotifications, markNotificationsRead, showToast } = vi.hoisted(() => ({
  getNotifications: vi.fn(), markNotificationsRead: vi.fn(), showToast: vi.fn(),
}))
vi.mock('../src/lib/endpoints', () => ({ getNotifications, markNotificationsRead }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => ({ showToast }) }))

const notice = { id: 'power-off', title: 'سرور خاموش شد', body: 'سرور «test-vm»', type: 'success',
  read: false, href: '/servers/test-vm?tab=operations', createdAt: '2026-11-14T00:00:00.000Z' }
const open = () => render(<StrictMode><MemoryRouter><NotificationCenter userId="user" /></MemoryRouter></StrictMode>)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('indexedDB', new IDBFactory())
  getNotifications.mockResolvedValue([notice])
})
afterEach(() => vi.unstubAllGlobals())

it('shows an unread result once across reconnect and refresh, with its persistent read state and link', async () => {
  const first = open()
  await waitFor(() => expect(showToast).toHaveBeenCalledOnce())
  fireEvent(window, new Event('online'))
  first.unmount()

  open()
  const bell = screen.getByRole('button', { name: 'اعلان‌ها' })
  fireEvent.click(bell)
  expect((await screen.findByRole('region', { name: 'مرکز اعلان‌ها' })).getAttribute('dir')).toBe('rtl')
  expect(screen.getByRole('link', { name: 'مشاهده جزئیات' }).getAttribute('href')).toBe(notice.href)
  expect(screen.getByText('سرور خاموش شد')).toBeTruthy()
  expect(screen.getByRole('region').querySelector('time')?.dateTime).toBe(notice.createdAt)

  markNotificationsRead.mockImplementation(async () => { getNotifications.mockResolvedValue([{ ...notice, read: true }]) })
  fireEvent.click(screen.getByRole('button', { name: 'خواندم سرور خاموش شد' }))
  expect(await screen.findByText('خوانده‌شده')).toBeTruthy()
  expect(markNotificationsRead).toHaveBeenCalledWith([notice.id])
  expect(showToast).toHaveBeenCalledOnce()

  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('region')).toBeNull()
  expect(document.activeElement).toBe(bell)
})

it('allows one toast claim when multiple tabs receive the same event', async () => {
  const claim = () => claimNotificationToasts('user', [notice], () => true)
  const simultaneous = await Promise.all([claim(), claim()])
  expect(simultaneous.flat()).toEqual([notice])
  expect(await claim()).toEqual([])
})
