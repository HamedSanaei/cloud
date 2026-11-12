import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { CreateServerPage } from '../src/pages/WizardPages'
import { WalletPage } from '../src/pages/FinancePages'
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
beforeEach(() => {
  sessionStorage.clear(); balance = 0; posts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['idempotency-key'] })
      return new Response(JSON.stringify({ data: { id: 'created-server' } }), { headers: { 'content-type': 'application/json' } })
    }
    const data = url.includes('/catalog/storefront') ? catalog : url.endsWith('/wallets') ? [{ id: 'wallet', name: 'Test wallet', balance }] : url.includes('integration/status') ? { enabled: false, linked: false } : []
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
  }))
})
function open() {
  return render(<MemoryRouter initialEntries={['/servers/create']}><ToastProvider><Routes>
    <Route path="/servers/create" element={<CreateServerPage />} /><Route path="/wallet" element={<WalletPage />} />
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
  await user.click(screen.getByRole('button', { name: /Ubuntu/ }))
  await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
  await user.selectOptions(await screen.findByLabelText('کیف پول پرداخت'), 'wallet')
  return user
}

describe('Issue #3 server checkout', () => {
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
    expect(saved).toMatchObject({ offerId: 'Cheap', os: 'ubuntu', walletId: 'wallet', location: 'nbg1', billingPeriod: 'hourly', step: 4 })
    expect(readCheckoutDraft('other-user')).toBeNull()
    balance = 168000 // Exactly one week at 1,000 toman/hour.
    await user.click(await screen.findByRole('link', { name: 'بازگشت به سفارش سرور' }))
    await waitFor(() => expect((screen.getByLabelText('کیف پول پرداخت') as HTMLSelectElement).value).toBe('wallet'))
    await user.click(screen.getByRole('button', { name: 'مرحله بعد' }))
    await user.type(screen.getByRole('textbox', { name: /نام سرور/ }), 'test-server')
    expect((screen.getByRole('button', { name: 'تایید و ایجاد سرور' }) as HTMLButtonElement).disabled).toBe(false)
    expect(readCheckoutDraft('checkout-user')!.purchaseKey).toBe(saved.purchaseKey)
  })
  it('does not expose raw schema failures and keeps insufficient funds distinct', () => {
    expect(checkoutFailure(new ApiError('Unrecognized key: "idempotencyKey"', 422, { error: 'validation_error' })).message).not.toMatch(/idempotencyKey|Unrecognized/)
    expect(checkoutFailure(new ApiError('private', 422, { error: 'insufficient_funds' })).message).toBe('موجودی کیف پول شما کافی نیست.')
  })
  it('ignores expired and malformed drafts', () => {
    saveCheckoutDraft('user', { step: 5, providerId: 'hetzner', location: 'nbg1', offerId: 'x', os: 'ubuntu', name: 'test', walletId: 'w', billingPeriod: 'hourly', purchaseKey: 'key' })
    expect(readCheckoutDraft('user')?.step).toBe(5)
    clearCheckoutDraft('user')
    expect(readCheckoutDraft('user')).toBeNull()
    sessionStorage.setItem('server-checkout:user', '{broken')
    expect(readCheckoutDraft('user')).toBeNull()
  })
})
