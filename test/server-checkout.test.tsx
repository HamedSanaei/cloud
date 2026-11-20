import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { CreateServerPage } from '../src/pages/WizardPages'
import { InvoicesPage, WalletPage } from '../src/pages/FinancePages'
import { HetznerTraffic } from '../src/components/servers/HetznerTraffic'
import { ToastProvider } from '../src/components/ui/Toast'
import { createServer } from '../src/lib/endpoints'
import { ApiError } from '../src/lib/apiClient'
import { checkoutFailure, clearCheckoutDraft, readCheckoutDraft, saveCheckoutDraft } from '../src/lib/serverCheckout'

vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'checkout-user' } }) }))
const offer = (id: string, price: number) => ({ id, provider: 'hetzner', location: 'nbg1', name: id,
  category: 'cloud', vcpu: 2, memoryMb: 4096, diskGb: 40, trafficGb: null,
  operatingSystems: [{ id: 'ubuntu', label: 'Ubuntu' }], prices: [{ period: 'hourly', totalRial: price }] })
const catalog = { datacenters: [{ id: 'hetzner', name: 'Hetzner', logo: '/providers/hetzner.svg',
  locations: [{ code: 'nbg1', city: 'Nuremberg', country: 'DE' }, { code: 'hel1', city: 'Helsinki', country: 'FI' }], billingPeriods: ['hourly'] }],
  offers: [offer('Expensive', 20000), offer('Cheap', 10000)] }
let posts: Array<{ body: Record<string, unknown>; key?: string }>
let balance: number
let availableCatalog: typeof catalog
let acceptedOrder: { id: string; name: string } | null
let pricingUnavailable: boolean
let holdOrderResponse: boolean
let releaseOrderResponse: ((response: Response) => void) | undefined
beforeEach(() => {
  sessionStorage.clear(); balance = 0; posts = []; availableCatalog = catalog
  acceptedOrder = null; pricingUnavailable = false; holdOrderResponse = false; releaseOrderResponse = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (url.endsWith('/auth/operation-email/start')) {
        return Response.json({ data: { token: 'fixture', destination: 'qa@test.local', expiresIn: 120, resendAfter: 60 } })
      }
      posts.push({ body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['idempotency-key'] })
      if (holdOrderResponse && url.endsWith('/servers')) {
        acceptedOrder = { id: 'accepted-fixture', name: 'qa-recovery' }
        return new Promise<Response>(resolve => { releaseOrderResponse = resolve })
      }
      return new Response(JSON.stringify({ data: { id: 'created-server' } }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/servers/provisioning/by-request/')) return Response.json({ data: acceptedOrder })
    if (url.endsWith('/wallets/recharges/receipt-fixture')) return Response.json({ data: { id: 'receipt-fixture', status: 'succeeded' } })
    if (pricingUnavailable && url.includes('/catalog/storefront')) return Response.json({ error: 'eur_rate_unavailable', message: 'قیمت‌گذاری موقتاً در دسترس نیست.' }, { status: 503 })
    if (url.endsWith('/invoices')) return Response.json({ data: [{ id: 'traffic-invoice', number: 'INV-TRAFFIC', description: 'ترافیک مازاد هتزنر',
      amount: 1000, status: 'paid', date: '2026-11-18T00:00:00Z', traffic: [{ month: '2026-11', blocks: 1, previousOutgoingBytes: 1e12,
        outgoingBytes: 1_000_100_000_000, includedBytes: 1e12, taxRial: 0, totalRial: 10000, fxRate: '2000000', fxAt: '2026-11-18T00:00:00Z' }] }] })
    const data = url.includes('/catalog/storefront') ? availableCatalog : url.endsWith('/wallets') ? [{ id: 'wallet', name: 'Test wallet', balance }] : url.includes('integration/status') ? { enabled: false, linked: false } : []
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
  }))
})
function open(path = '/servers/create') {
  return render(<MemoryRouter initialEntries={[path]}><ToastProvider><Routes>
    <Route path="/servers/create" element={<CreateServerPage />} /><Route path="/wallet" element={<WalletPage />} />
    <Route path="/invoices" element={<InvoicesPage />} />
    <Route path="/servers" element={<Link to="/servers/create">ایجاد سرور جدید</Link>} />
  </Routes></ToastProvider></MemoryRouter>)
}
async function configure() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Hetzner/ }))
  expect(screen.queryByRole('combobox', { name: 'موقعیت سرور' })).toBeNull()
  expect(screen.getByAltText('پرچم آلمان')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /نورنبرگ/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.click(screen.getByRole('button', { name: /ساعتی.*پرداخت/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  expect(screen.getAllByRole('button').filter(button => /Cheap|Expensive/.test(button.textContent ?? '')).map(button => button.querySelector('strong')?.textContent)).toEqual(['Cheap', 'Expensive'])
  await user.click(screen.getByRole('button', { name: /Cheap/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'سیستم عامل' }))
  await user.click(screen.getByRole('button', { name: /Ubuntu/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await screen.findAllByText('موجودی کیف پول')
  expect(screen.queryByLabelText('کیف پول پرداخت')).toBeNull()
  return user
}

describe('Issue #3 server checkout', () => {
  it('shows the hourly policy and both backend price states without inventing a monthly amount', async () => {
    open()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Hetzner/ }))
    await user.click(screen.getByRole('button', { name: /نورنبرگ/ }))
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    expect(screen.queryByRole('button', { name: /روزانه/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /ساعتی.*پرداخت/ }))
    expect(screen.getByText(/در پرداخت ساعتی، هزینه هر ساعت با نرخ معتبر دلار/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    const card = screen.getByRole('button', { name: /Cheap/ })
    expect(card.textContent).toContain('قیمت ساعتی:')
    expect(card.textContent).toContain('قیمت ماهانه: در دسترس نیست')
    expect(card.textContent).toContain('(دوره انتخابی)')
    expect(posts).toEqual([])
  })

  it.each(['hourly', 'monthly'])('opens a public %s offer without placing an order', async period => {
    availableCatalog = {
      datacenters: catalog.datacenters.map(dc => ({ ...dc, billingPeriods: ['hourly', 'monthly'] })),
      offers: catalog.offers.map(item => ({ ...item, prices: [...item.prices, { period: 'monthly', totalRial: 1000000 }] })),
    }
    open(`/servers/create?offer=Cheap&period=${period}&location=nbg1`)
    expect(await screen.findByRole('button', { name: /Ubuntu/ })).toBeTruthy()
    expect(posts).toEqual([])
  })

  it('returns to location selection if the public price period is no longer available', async () => {
    open('/servers/create?offer=Cheap&period=monthly')
    expect(await screen.findByText(/پلن لینک‌شده دیگر/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Hetzner/ })).toBeTruthy()
  })

  it('shows both locations and returns to the first step if a public link no longer matches', async () => {
    open('/servers/create?offer=Cheap&period=hourly&location=hel1')
    const warning = await screen.findByText(/موقعیت درخواستی/)
    expect(warning.textContent).toMatch(/hel1.*nbg1/)
    expect(screen.getByRole('heading', { name: 'دیتاسنتر و موقعیت' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Ubuntu/ })).toBeNull()
    expect(posts).toEqual([])
  })

  it('lets the same user return to checkout from a payment receipt with no returnTo query', async () => {
    saveCheckoutDraft('checkout-user', { step: 4, providerId: 'hetzner', location: 'nbg1', offerId: 'Cheap', os: 'ubuntu',
      name: '', billingPeriod: 'hourly', purchaseKey: crypto.randomUUID() })
    const user = userEvent.setup()
    open('/wallet?payment=receipt-fixture')
    expect(await screen.findByText('پرداخت تأیید شد و کیف پول شارژ شد.')).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'بازگشت به سفارش سرور' }))
    expect(await screen.findByText('موجودی کیف پول شما کافی نیست.')).toBeTruthy()
  })

  it('keeps one confirmation open on a second mouse press and recovers a committed order after refresh', async () => {
    balance = 168000
    holdOrderResponse = true
    const page = open()
    const user = await configure()
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    await user.type(screen.getByRole('textbox', { name: /نام سرور/ }), 'qa-recovery')
    await user.click(screen.getByRole('button', { name: 'تایید و ایجاد سرور' }))
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!, { detail: 2 })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'ارسال کد به ایمیل' }))
    await user.type(await screen.findByRole('textbox', { name: 'کد تأیید ایمیل' }), '123456')
    await user.click(screen.getByRole('button', { name: 'تأیید کد و ادامه' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(readCheckoutDraft('checkout-user')).toMatchObject({ submitted: true, step: 5, purchaseKey: posts[0]!.key })
    page.unmount()
    balance -= 1000
    open()
    expect(screen.queryByText('موجودی کیف پول شما کافی نیست.')).toBeNull()
    expect(await screen.findByRole('link', { name: 'ایجاد سرور جدید' })).toBeTruthy()
    expect(readCheckoutDraft('checkout-user')).toBeNull()
    expect(posts).toHaveLength(1)
    await act(async () => { releaseOrderResponse?.(Response.json({ data: acceptedOrder })) })
  })

  it('converts byte allowances and shows decimal TB in the panel', () => {
    const stamp = '2026-11-18T00:00:00Z'
    render(<HetznerTraffic includedBytes={20 * 2 ** 40} overage={{ perTbRial: 100000, includedBytes: null,
      source: 'hetzner-server-type-location', observedAt: stamp, fxAt: stamp, ruleVersion: stamp }} />)
    expect(screen.getByText('۲۱٫۹۹۰۲۳۲۵۵۵۵۲ TB')).toBeTruthy()
    expect(screen.getByText('/ TB')).toBeTruthy()
  })

  it('keeps checkout blocked during missing FX and retries successfully in the same session', async () => {
    pricingUnavailable = true
    open()
    await screen.findByRole('alert')
    expect((screen.getByRole('button', { name: 'مرحله بعد' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /Hetzner/ })).toBeNull()
    pricingUnavailable = false
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }))
    await user.click(await screen.findByRole('button', { name: /Hetzner/ }))
    await user.click(screen.getByRole('button', { name: /نورنبرگ/ }))
    expect((screen.getByRole('button', { name: 'مرحله بعد' }) as HTMLButtonElement).disabled).toBe(false)
    expect(posts).toEqual([])
  })

  it('renders invoice traffic usage and billed volume in TB without altering the invoice amount', async () => {
    open('/invoices')
    const details = (await screen.findByText('جزئیات ترافیک مازاد')).parentElement!
    expect(details.textContent).toContain('۰٫۰۰۰۱ TB')
    expect(details.textContent).toContain('۱٫۰۰۰۱ TB')
    expect(details.textContent).toContain('۱۰۰۰۰ ریال')
  })
  it('sends idempotency only in the header accepted by the strict API', async () => {
    await createServer({ name: 'test-server', offerId: 'offer', os: 'ubuntu', billingPeriod: 'hourly', walletId: 'wallet', idempotencyKey: 'stable-key' })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.key).toBe('stable-key')
    expect(posts[0]!.body).toEqual({ name: 'test-server', offerId: 'offer', os: 'ubuntu', billingPeriod: 'hourly', walletId: 'wallet' })
  })
  it('guides zero-balance users to the wallet and restores their choices and request key after recharge', async () => {
    open()
    const user = await configure()
    expect(screen.getByText('موجودی کیف پول شما کافی نیست.')).toBeTruthy()
    expect(posts).toHaveLength(0)
    await user.click(screen.getByRole('link', { name: 'افزایش موجودی کیف پول' }))
    const saved = readCheckoutDraft('checkout-user')!
    expect(saved).toMatchObject({ offerId: 'Cheap', os: 'ubuntu', location: 'nbg1', billingPeriod: 'hourly', step: 4 })
    expect(readCheckoutDraft('other-user')).toBeNull()
    balance = 168000 // Exactly one week at 1,000 toman/hour.
    await user.click(await screen.findByRole('link', { name: 'بازگشت به سفارش سرور' }))
    await screen.findAllByText('موجودی کیف پول')
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    await user.type(screen.getByRole('textbox', { name: /نام سرور/ }), 'test-server')
    expect((screen.getByRole('button', { name: 'تایید و ایجاد سرور' }) as HTMLButtonElement).disabled).toBe(false)
    expect(readCheckoutDraft('checkout-user')!.purchaseKey).toBe(saved.purchaseKey)
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: 'مرحله قبل' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'دیتاسنتر و موقعیت' }))
    await user.click(screen.getByRole('button', { name: 'انصراف' }))
    expect(readCheckoutDraft('checkout-user')).toBeNull()
    await user.click(screen.getByRole('link', { name: 'ایجاد سرور جدید' }))
    expect(screen.getByRole('heading', { name: 'دیتاسنتر و موقعیت' })).toBeTruthy()
    expect(screen.queryByDisplayValue('test-server')).toBeNull()
  })
  it('labels monthly funding as a prepaid month in the wallet, review and shortfall', async () => {
    availableCatalog = {
      datacenters: catalog.datacenters.map(item => ({ ...item, billingPeriods: ['hourly', 'monthly'] })),
      offers: catalog.offers.map(item => ({ ...item, prices: [...item.prices, { period: 'monthly', totalRial: 250000 }] })),
    }
    saveCheckoutDraft('checkout-user', { step: 4, providerId: 'hetzner', location: 'nbg1', billingPeriod: 'monthly', offerId: 'Cheap', os: 'ubuntu', name: '', purchaseKey: 'monthly-checkout' })
    open()
    expect(await screen.findByText(/پیش‌پرداخت دورهٔ ماهانه:/)).toBeTruthy()
    expect(await screen.findByText(/پیش‌پرداخت دورهٔ ماهانه لازم است/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    expect(screen.getByText('پیش‌پرداخت دورهٔ ماهانه')).toBeTruthy()
    expect(screen.queryByText(/حداقل اعتبار برای ۷ روز/)).toBeNull()
  })
  it('does not expose raw schema failures and keeps insufficient funds distinct', () => {
    expect(checkoutFailure(new ApiError('Unrecognized key: "idempotencyKey"', 422, { error: 'validation_error' })).message).not.toMatch(/idempotencyKey|Unrecognized/)
    expect(checkoutFailure(new ApiError('private', 422, { error: 'insufficient_funds' })).message).toBe('موجودی کیف پول شما کافی نیست.')
  })
  it('ignores expired and malformed drafts', () => {
    saveCheckoutDraft('user', { step: 5, providerId: 'hetzner', location: 'nbg1', offerId: 'x', os: 'ubuntu', name: 'test', billingPeriod: 'hourly', purchaseKey: 'key' })
    expect(readCheckoutDraft('user')?.step).toBe(5)
    clearCheckoutDraft('user')
    expect(readCheckoutDraft('user')).toBeNull()
    sessionStorage.setItem('server-checkout:user', '{broken')
    expect(readCheckoutDraft('user')).toBeNull()
  })
})
