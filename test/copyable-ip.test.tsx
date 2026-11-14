import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { CopyableIp } from '../src/components/ui/CopyableIp'
import { ServerTableRow } from '../src/components/servers/ServerPrimitives'
import { MemoryRouter } from 'react-router-dom'
import type { Server } from '../src/lib/types'
// @ts-expect-error Synthetic JS fixture shared with the loopback preview.
import { readyServer } from './server-management-fixtures.mjs'

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})
const addresses = ['192.0.2.40', '2001:0DB8:0000:0000:0000:0000:0000:0042/128']

it('copies exact raw IPv4 and IPv6 with one click and keyboard activation without bubbling', async () => {
  const user = userEvent.setup(), parent = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<div dir="rtl" onClick={parent}>{addresses.map(address => <CopyableIp key={address} value={address} />)}</div>)
  const [ipv4, ipv6] = addresses.map(address => screen.getByRole('button', { name: `کپی آی‌پی ${address}` }))
  expect(ipv6?.getAttribute('dir')).toBe('ltr')
  await user.click(ipv4!)
  expect(writeText).toHaveBeenCalledExactlyOnceWith(addresses[0])
  expect(await screen.findByText('آی‌پی کپی شد')).toBeTruthy()
  await user.tab()
  expect(document.activeElement).toBe(ipv6)
  await user.keyboard('{Enter}[Space]')
  expect(writeText.mock.calls).toEqual([[addresses[0]], [addresses[1]], [addresses[1]]])
  expect(parent).not.toHaveBeenCalled()
})

it('selects the full address for manual copying when clipboard permission is denied', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  render(<CopyableIp value={addresses[1]} />)
  fireEvent.click(screen.getByRole('button'))
  const input = await screen.findByRole<HTMLInputElement>('textbox')
  await waitFor(() => expect(input.selectionEnd).toBe(input.value.length))
  expect(input.selectionStart).toBe(0)
  expect(input.value).toBe(addresses[1])
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole('status').textContent).toContain('کپی خودکار ممکن نبود')
})

it('does not offer copy for missing or invalid values', () => {
  render(<div>{[undefined, '—', 'unknown', '1.2.3.999', '2001:::1', '2001:db8::/129', '0.0.0.0', '::'].map((value, i) => <CopyableIp key={i} value={value} />)}</div>)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getAllByText('در دسترس نیست')).toHaveLength(8)
})

it('removes copy and pending feedback when an address becomes unavailable', async () => {
  let finish: () => void = () => undefined
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => new Promise<void>(resolve => { finish = resolve })) } })
  const view = render(<CopyableIp value={addresses[0]} />)
  fireEvent.click(screen.getByRole('button'))
  view.rerender(<CopyableIp value={addresses[0]} unavailableReason="سرور حذف شده؛ آدرس فعال ندارد" />)
  await act(async () => finish())
  expect(screen.getByText('سرور حذف شده؛ آدرس فعال ندارد')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('آی‌پی کپی شد')).toBeNull()
  expect(screen.queryByText(addresses[0])).toBeNull()
})

it('replaces historical addresses on deleted list rows while retaining the details/history link', () => {
  const row: Server = { ...readyServer, status: 'inactive', lifecycle: 'terminated', ip: addresses[0], ipv6: addresses[1] }
  render(<MemoryRouter><table><tbody><ServerTableRow server={row} /></tbody></table></MemoryRouter>)
  expect(screen.getByText('سرور حذف شده؛ آدرس فعال ندارد')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /کپی آی‌پی/ })).toBeNull()
  for (const address of addresses) expect(screen.queryByText(address)).toBeNull()
  expect(screen.getByRole('link', { name: 'مشاهده جزئیات' }).getAttribute('href')).toBe(`/servers/${row.id}`)
  expect(row.ip).toBe(addresses[0]) // Rendering never erases historical source data.
})

it.each(['ready', 'deleting', 'delete_failed', 'outcome_unknown'] as const)('retains exact address copying for an existing server in %s state', async lifecycle => {
  const user = userEvent.setup(), writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const row: Server = { ...readyServer, status: 'inactive', lifecycle, ip: addresses[0], ipv6: addresses[1] }
  render(<MemoryRouter><table><tbody><ServerTableRow server={row} /></tbody></table></MemoryRouter>)
  await user.click(screen.getByRole('button', { name: `کپی آی‌پی ${addresses[1]}` }))
  expect(writeText).toHaveBeenCalledExactlyOnceWith(addresses[1])
})
