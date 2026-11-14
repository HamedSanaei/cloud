import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { CopyableIp } from '../src/components/ui/CopyableIp'

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
