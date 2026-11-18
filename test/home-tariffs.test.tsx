import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { LandingPage } from '../src/pages/LandingPage'
import { AuthProvider } from '../src/auth/AuthContext'
import { renderHomeTariffs, type PublicHetznerOffer } from '../backend/src/contracts/home-tariffs'
import { HomeTariffs } from '../src/components/HomeTariffs'

const plan = { id: 'fixture', name: 'CX <test>', location: 'hel1', vcpu: 2, memoryMb: 4096, diskGb: 40, diskType: 'Local', trafficGb: null, hourly: 123450, monthly: null }

it('renders trusted public prices, scopes table headers and links to the actual offer and period', () => {
  const initial = renderHomeTariffs({ rates: { outbound: 150000, inbound: 0, cpu: 250000, ram: null }, trafficUnit: 'TB', tax: 'excluded' }, [plan])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
  render(<MemoryRouter><AuthProvider><LandingPage initialTariffs={initial} /></AuthProvider></MemoryRouter>)
  const headings = screen.getAllByRole('heading', { level: 1 })
  expect(headings).toHaveLength(1)
  expect(headings[0]?.firstChild?.textContent).toBe('سرور ابری ایران و هتزنر')
  expect(headings[0]?.querySelector('em')?.textContent).toBe('با پرداخت ریالی و امکان خرید به صورت ساعتی')
  const name = 'خرید اکانت هتزنر'
  const faqLink = within(screen.getByRole('main')).getByRole('link', { name })
  const footerNav = within(screen.getByRole('contentinfo')).getByRole('navigation')
  const footerLink = within(footerNav).getByRole('link', { name })
  expect(faqLink.getAttribute('href')).toBe('https://pluspremium.ir/')
  expect(footerLink.getAttribute('href')).toBe(faqLink.getAttribute('href'))
  expect(footerLink.getAttribute('rel')).toBe('sponsored')
  expect(within(footerNav).getByRole('link', { name: 'سرور هتزنر' }).getAttribute('href')).toBe('/hetzner')
  const hetzner = within(screen.getByRole('table', { name: 'پلن‌های قابل سفارش هتزنر' }))
  expect(hetzner.getByRole('rowheader', { name: 'CX <test>' })).toBeTruthy()
  expect(hetzner.getByText('۱۲٬۳۴۵ تومان')).toBeTruthy()
  expect(hetzner.getByRole('link', { name: /خرید CX/ }).getAttribute('href')).toBe('/servers/create?offer=fixture&period=hourly&location=hel1')
  expect(hetzner.getByText('قیمت ماهانهٔ معتبر در دسترس نیست')).toBeTruthy()
  expect(screen.getByText('۰ تومان')).toBeTruthy()
})

it('retains a healthy snapshot on reconnect failure, but hides prices at their original expiry', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/public/home-prices')
    ? Response.json({}, { status: 503 }) : Response.json({}, { status: 401 })))
  render(<HomeTariffs initialHtml={renderHomeTariffs(null, [plan])} />)
  expect(screen.getAllByText('۱۲٬۳۴۵ تومان').length).toBeGreaterThan(0)
  try {
    await act(async () => { fireEvent(window, new Event('online')) })
    expect(screen.getByText(/به‌روزرسانی قیمت انجام نشد/)).toBeTruthy()
    expect(screen.getAllByText('۱۲٬۳۴۵ تومان').length).toBeGreaterThan(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001) })
    expect(screen.queryAllByText('۱۲٬۳۴۵ تومان')).toHaveLength(0)
    expect(screen.getByText(/اعتبار این بررسی تمام شده/)).toBeTruthy()
  } finally { vi.useRealTimers() }
})

const snapshot = (offers: PublicHetznerOffer[] = [plan]) => ({ iran: null, hetzner: offers, meta: {
  status: 'available' as const, checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), catalogUpdatedAt: null, fxUpdatedAt: null,
} })

it('preserves a valid SSR snapshot on null/malformed responses and immediately removes withdrawn inventory', async () => {
  const next = vi.fn().mockResolvedValueOnce(Response.json({ data: { ...snapshot(), hetzner: null } }))
    .mockResolvedValueOnce(Response.json({ data: { ...snapshot(), hetzner: [{ ...plan, hourly: 'fake' }] } }))
    .mockResolvedValueOnce(Response.json({ data: snapshot([]) }))
  vi.stubGlobal('fetch', next)
  const data = snapshot()
  render(<HomeTariffs initialHtml={renderHomeTariffs(null, data.hetzner, data.meta)} scope="hetzner" />)
  for (let n = 0; n < 2; n++) {
    await act(async () => { fireEvent(window, new Event('online')) })
    expect(screen.getAllByText('۱۲٬۳۴۵ تومان').length).toBeGreaterThan(0)
  }
  await act(async () => { fireEvent(window, new Event('online')) })
  expect(screen.queryAllByText('۱۲٬۳۴۵ تومان')).toHaveLength(0)
  expect(screen.getByText(/پلن قابل سفارش هتزنر برای نمایش وجود ندارد/)).toBeTruthy()
})

it('sorts by independent retail monthly prices and filters real catalog locations', async () => {
  const data = snapshot([{ ...plan, name: 'CX monthly', monthly: 900000 }, { ...plan, id: 'de', name: 'CX Germany', location: 'nbg1', country: 'DE', monthly: 800000, hourly: 200000 }])
  render(<HomeTariffs initialHtml={renderHomeTariffs(null, data.hetzner, data.meta)} scope="hetzner" />)
  const firstPlan = () => screen.getAllByRole('rowheader')[0].textContent
  expect(firstPlan()).toBe('CX monthly')
  fireEvent.change(screen.getByLabelText('مقایسه از کم‌هزینه به بیشتر'), { target: { value: 'monthly' } })
  expect(firstPlan()).toBe('CX Germany')
  fireEvent.change(screen.getByLabelText('موقعیت دیتاسنتر'), { target: { value: 'hel1' } })
  expect(screen.getAllByRole('rowheader')).toHaveLength(1)
  expect(firstPlan()).toBe('CX monthly')
})
