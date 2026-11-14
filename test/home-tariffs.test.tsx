import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { LandingPage } from '../src/pages/LandingPage'
import { AuthProvider } from '../src/auth/AuthContext'
import { renderHomeTariffs } from '../backend/src/contracts/home-tariffs'

const plan = { id: 'fixture', name: 'CX <test>', location: 'hel1', vcpu: 2, memoryMb: 4096, diskGb: 40, diskType: 'Local', trafficGb: null, hourly: 123450, monthly: null }

it('renders trusted public prices, scopes table headers and links to the actual offer and period', () => {
  const initial = renderHomeTariffs({ rates: { outbound: 150000, inbound: 0, cpu: 250000, ram: null }, trafficUnit: 'TB', tax: 'excluded' }, [plan])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  render(<MemoryRouter><AuthProvider><LandingPage initialTariffs={initial} /></AuthProvider></MemoryRouter>)
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'خرید اکانت هتزنر' }).getAttribute('href')).toBe('https://pluspremium.ir/')
  const hetzner = within(screen.getByRole('table', { name: 'پلن‌های قابل سفارش هتزنر' }))
  expect(hetzner.getByRole('rowheader', { name: 'CX <test>' })).toBeTruthy()
  expect(hetzner.getByText('۱۲٬۳۴۵ تومان')).toBeTruthy()
  expect(hetzner.getByRole('link', { name: /خرید CX/ }).getAttribute('href')).toBe('/servers/create?offer=fixture&period=hourly')
  expect(hetzner.getByText('عرضه نمی‌شود')).toBeTruthy()
  expect(screen.getByText('۰ تومان')).toBeTruthy()
})

it('reloads on reconnect and clears prices when the public pricing request fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/public/home-prices')
    ? Response.json({}, { status: 503 }) : Response.json({}, { status: 401 })))
  render(<MemoryRouter><AuthProvider><LandingPage initialTariffs={renderHomeTariffs(null, [plan])} /></AuthProvider></MemoryRouter>)
  expect(screen.getByText('۱۲٬۳۴۵ تومان')).toBeTruthy()
  fireEvent(window, new Event('online'))
  expect(await screen.findByText(/دریافت تعرفهٔ هتزنر موقتاً/)).toBeTruthy()
  expect(screen.queryByText('۱۲٬۳۴۵ تومان')).toBeNull()
  expect(screen.getAllByText('استعلام قیمت')).toHaveLength(4)
})
