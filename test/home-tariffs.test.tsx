import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  expect(headings[0]?.nextElementSibling?.textContent).toBe('با پرداخت ریالی و امکان خرید به صورت ساعتی')
  const name = 'خرید اکانت هتزنر'
  const faqLink = within(screen.getByRole('main')).getByRole('link', { name })
  const footerNav = within(screen.getByRole('contentinfo')).getByRole('navigation')
  const footerLink = within(footerNav).getByRole('link', { name })
  expect(faqLink.getAttribute('href')).toBe('https://pluspremium.ir/')
  expect(footerLink.getAttribute('href')).toBe(faqLink.getAttribute('href'))
  expect(footerLink.getAttribute('rel')).toBe('sponsored')
  expect(within(footerNav).getByRole('link', { name: 'سرور هتزنر' }).getAttribute('href')).toBe('/hetzner')
  const hetzner = within(screen.getByRole('table', { name: 'پلن‌های قابل سفارش هتزنر' }))
  expect(hetzner.getByRole('rowheader').textContent).toContain('CX <test>')
  expect(hetzner.getByText('۱۲٬۳۴۵ تومان')).toBeTruthy()
  expect(hetzner.getByRole('link', { name: /خرید CX/ }).getAttribute('href')).toBe('/servers/create?offer=fixture&period=hourly&location=hel1')
  expect(hetzner.getByText('قیمت ماهانهٔ معتبر در دسترس نیست')).toBeTruthy()
  expect(screen.getByText('۰ تومان')).toBeTruthy()
})

it.each(['all', 'hetzner'] as const)('shows the same rounded money and exact allowance in SSR and the %s browser table', scope => {
  const current = snapshot([{ ...plan, hourly: 1_234_567, monthly: 50_000_004, includedTrafficBytes: 2 ** 39,
    trafficOverage: { perTbRial: 3_334_555, includedBytes: 2 ** 39, source: 'hetzner-server-type-location',
      observedAt: '2026-11-18T00:00:00Z', fxAt: '2026-11-18T00:00:00Z', ruleVersion: '2026-11-18T00:00:00Z' } }])
  const iran = { rates: { outbound: 1234567, inbound: 0, cpu: null, ram: null }, trafficUnit: 'TB', tax: 'excluded' } as const
  const initial = renderHomeTariffs(iran, current.hetzner, current.meta, scope)
  const ssr = new DOMParser().parseFromString(initial, 'text/html')
  render(<HomeTariffs initialHtml={initial} scope={scope} />)
  const table = screen.getByRole('table', { name: 'پلن‌های قابل سفارش هتزنر' })
  expect(table.outerHTML).toBe(ssr.querySelector('#hetzner-server table')?.outerHTML)
  const [location, ...prices] = within(table).getAllByRole('cell')
  expect(within(location).getByText('hel1')).toBeTruthy()
  expect(within(location).getByText('کشور نامشخص')).toBeTruthy()
  expect(prices.map(cell => cell.textContent)).toEqual([
    '۲', '۴', '۴۰', '۰٫۵ TB', '۱۲۳٬۴۵۷ تومان', '۵٬۰۰۰٬۰۰۰ تومان', '۳۳۳٬۴۵۶ تومان',
  ])
  expect(within(table).getAllByRole('link')).toHaveLength(1)
  expect(within(table).getByRole('columnheader', { name: 'RAM (گیگابایت)' })).toBeTruthy()
  expect(within(table).getByRole('columnheader', { name: 'فضای دیسک (گیگابایت)' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'تعرفه سرور هتزنر', level: 3 })).toBeTruthy()
  expect(screen.getByText(/هزینهٔ مازاد ساعتی محاسبه می‌شود/)).toBeTruthy()
  expect(screen.getByText(/کم‌هزینه‌ترین گزینهٔ همین فهرست/).textContent).toContain('۵٬۰۰۰٬۰۰۰ تومان')
  if (scope === 'all') expect(within(screen.getByRole('table', { name: 'نرخ واحد منابع سرور ایران' })).getByText('۱۲۳٬۴۵۷ تومان')).toBeTruthy()
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
  const firstRow = () => screen.getAllByRole('rowheader')[0]
  const firstPlan = () => within(firstRow()).getByRole('link')
  const bar = screen.getByRole('heading', { name: 'تعرفه سرور هتزنر' }).parentElement!
  expect(within(bar).getAllByRole('combobox')).toHaveLength(3)
  expect(firstPlan().textContent).toBe('CX Germany')
  expect(firstPlan().getAttribute('href')).toContain('period=hourly')
  expect(firstPlan().getAttribute('href')).toBe('/servers/create?offer=de&period=hourly&location=nbg1')
  fireEvent.change(screen.getByLabelText('مبنای قیمت'), { target: { value: 'hourly' } })
  expect(firstPlan().textContent).toBe('CX monthly')
  fireEvent.change(screen.getByLabelText('موقعیت دیتاسنتر'), { target: { value: 'hel1' } })
  expect(screen.getAllByRole('rowheader')).toHaveLength(1)
  expect(firstPlan().textContent).toBe('CX monthly')
  expect(firstPlan().getAttribute('href')).toBe('/servers/create?offer=fixture&period=hourly&location=hel1')
})

const catalog = ([
  ['fsn1', 'de', 'Falkenstein'], ['nbg1', 'DE', 'Nuremberg'],
  ['ash', 'US', 'Ashburn'], ['hil', 'US', 'Hillsboro'],
  ['hel1', 'FI', 'Helsinki'], ['sin', 'SG', 'Singapore'],
  ['lon', 'GB', 'London'], ['unknown', 'ZZ', 'Unassigned'],
] as const).map(([location, country, city], index) => ({
  ...plan, id: location, name: `CX ${location}`, location, country, city,
  hourly: 1_000 + index, monthly: 10_000 - index,
}))

it('uses actual countries, reconciles location filters and preserves sort and order links', async () => {
  const user = userEvent.setup(), current = snapshot(catalog)
  const initial = renderHomeTariffs(null, catalog, current.meta)
  const ssr = new DOMParser().parseFromString(initial, 'text/html')
  const beforeScript = ssr.querySelector('#hetzner-server table')!
  expect(beforeScript.tBodies[0].rows).toHaveLength(8)
  expect(beforeScript.tHead?.rows[0].cells[1].textContent).toBe('لوکیشن')
  expect(beforeScript.querySelector('summary[aria-label="آلمان"] img')?.getAttribute('src')).toBe('/flags/de.svg')
  expect(beforeScript.querySelector('summary[aria-label="آلمان"]')?.parentElement?.nextElementSibling?.textContent).toBe('Nuremberg، nbg1')
  expect(beforeScript.textContent).toContain('کشور نامشخص')

  render(<HomeTariffs initialHtml={initial} />)
  const filters = within(screen.getByRole('group', { name: 'کشور دیتاسنتر' }))
  const all = filters.getByRole('button', { name: 'همه کشورها' })
  const table = () => within(screen.getByRole('table', { name: 'پلن‌های قابل سفارش هتزنر' }))
  const plans = () => table().getAllByRole('link').map(link => link.textContent)
  const location = screen.getByLabelText('موقعیت دیتاسنتر') as HTMLSelectElement
  expect(all.getAttribute('aria-pressed')).toBe('true')
  expect(filters.getAllByRole('button')).toHaveLength(6)
  expect(plans()).toHaveLength(8)
  expect(filters.getByRole('button', { name: 'بریتانیا' }).querySelector('.tariff-flag-emoji')?.textContent).toBe('🇬🇧')

  await user.selectOptions(location, 'hel1')
  const germany = filters.getByRole('button', { name: 'آلمان' })
  germany.focus()
  await user.keyboard('{Enter}')
  expect(germany.getAttribute('aria-pressed')).toBe('true')
  expect(location.value).toBe('')
  expect([...location.options].map(option => option.value)).toEqual(['', 'fsn1', 'nbg1'])
  expect(plans()).toEqual(['CX nbg1', 'CX fsn1'])
  await user.selectOptions(screen.getByLabelText('مبنای قیمت'), 'hourly')
  expect(plans()).toEqual(['CX fsn1', 'CX nbg1'])
  await user.selectOptions(screen.getByLabelText('مبنای قیمت'), 'monthly')
  expect(plans()).toEqual(['CX nbg1', 'CX fsn1'])
  expect(table().getByRole('link', { name: /خرید CX nbg1/ }).getAttribute('href')).toBe('/servers/create?offer=nbg1&period=hourly&location=nbg1')
  await user.selectOptions(screen.getByLabelText('مرتب‌سازی بر اساس'), 'price:desc')
  expect(plans()).toEqual(['CX fsn1', 'CX nbg1'])
  expect(screen.getByText(/کم‌هزینه‌ترین گزینهٔ همین فهرست/).textContent).toContain('CX nbg1')
  await user.selectOptions(screen.getByLabelText('مرتب‌سازی بر اساس'), 'price:asc')

  for (const [name, expected] of [
    ['ایالات متحده', ['CX hil', 'CX ash']], ['فنلاند', ['CX hel1']], ['سنگاپور', ['CX sin']],
  ] as const) {
    await user.click(filters.getByRole('button', { name }))
    expect(plans()).toEqual(expected)
    expect(filters.getAllByRole('button', { pressed: true })).toHaveLength(1)
  }
  await user.click(all)
  expect(plans()).toHaveLength(8)
  expect(table().getByText('کشور نامشخص')).toBeTruthy()
  await user.selectOptions(location, 'hil')
  expect(plans()).toEqual(['CX hil'])
})

it('keeps compatible filters during refresh and offers a reset when the selected country is withdrawn', async () => {
  const next = vi.fn().mockResolvedValueOnce(Response.json({ data: snapshot(catalog.filter(offer => offer.location !== 'fsn1')) }))
    .mockResolvedValueOnce(Response.json({ data: snapshot(catalog.filter(offer => !['DE', 'de'].includes(offer.country))) }))
  vi.stubGlobal('fetch', next)
  render(<HomeTariffs initialHtml={renderHomeTariffs(null, catalog, snapshot().meta, 'hetzner')} scope="hetzner" />)
  const filters = within(screen.getByRole('group', { name: 'کشور دیتاسنتر' }))
  fireEvent.click(filters.getByRole('button', { name: 'آلمان' }))
  const location = screen.getByLabelText('موقعیت دیتاسنتر') as HTMLSelectElement
  fireEvent.change(location, { target: { value: 'fsn1' } })
  await act(async () => { fireEvent(window, new Event('online')) })
  expect(location.value).toBe('')
  expect(filters.getByRole('button', { name: 'آلمان', pressed: true })).toBeTruthy()
  expect(screen.getByRole('link', { name: /خرید CX nbg1/ })).toBeTruthy()
  await act(async () => { fireEvent(window, new Event('online')) })
  expect(screen.getByText('سروری برای این کشور یافت نشد')).toBeTruthy()
  fireEvent.click(filters.getByRole('button', { name: 'همه کشورها' }))
  expect(screen.getAllByRole('rowheader')).toHaveLength(6)
})
