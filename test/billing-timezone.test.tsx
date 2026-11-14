import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { WalletPage, InvoicesPage } from '../src/pages/FinancePages'
import { ToastProvider } from '../src/components/ui/Toast'
import { formatFaDateTime } from '../src/lib/format'

const { account } = vi.hoisted(() => ({ account: { timezone: 'Asia/Tehran' } }))
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: account }) }))
vi.mock('../src/components/ui/WalletRecharge', () => ({ WalletRecharge: () => null }))
vi.mock('../src/lib/platformClient', () => ({ getIntegrationStatus: async () => ({ enabled: false }) }))
const posted = '2026-11-13T23:26:00Z', due = '2026-11-13T23:25:00Z'
vi.mock('../src/lib/endpoints', () => ({
  getWalletSummary: async () => ({ totalBalance: 100, wallets: 1 }), listWallets: async () => [],
  listTransactions: async () => [{ id: 'tx-1', description: 'پرداخت خودکار تمدید INV-1', amount: -100, date: posted, scheduledAt: due, status: 'success' }],
  listInvoices: async () => [{ id: 'inv-1', number: 'INV-1', description: 'تمدید ساعتی', amount: 100, date: posted, dueAt: due, paidAt: posted, status: 'paid' }],
  listChargeRequests: async () => [], createWallet: vi.fn(),
}))
beforeEach(() => {
  localStorage.clear(); account.timezone = 'Asia/Tehran'
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-14T03:00:00Z'))
})
afterEach(() => vi.restoreAllMocks())
const open = (page: React.ReactNode) => render(<MemoryRouter><ToastProvider>{page}</ToastProvider></MemoryRouter>)
describe('configured billing dates', () => {
  it('uses Solar Hijri Persian digits, Tehran midnight rollover and a 24-hour clock', () => {
    expect(formatFaDateTime('2026-11-13T20:20:00Z')).toContain('۱۴۰۵/۰۸/۲۲')
    expect(formatFaDateTime('2026-11-13T20:40:00Z')).toContain('۱۴۰۵/۰۸/۲۳')
    expect(formatFaDateTime(posted)).toContain('۰۲:۵۶')
    expect(formatFaDateTime(posted)).toContain('به وقت ایران')
    expect(formatFaDateTime('invalid')).toBe('—')
    expect(formatFaDateTime(posted, 'invalid')).toContain('به وقت ایران')
  })
  it('honors account timezone ahead of a stale browser preference', () => {
    localStorage.setItem('cloud-timezone', 'UTC')
    expect(formatFaDateTime(posted, 'Asia/Tehran')).toContain('۰۲:۵۶')
    expect(formatFaDateTime(posted, 'UTC')).toContain('۲۳:۲۶')
    expect(formatFaDateTime(posted, 'UTC')).toContain('به وقت UTC')
  })
  it.each([['wallet', () => <WalletPage />, 'پرداخت خودکار تمدید INV-1'], ['invoices', () => <InvoicesPage />, 'INV-1']] as const)('formats historical %s rows and separates due time from posting', async (_name, page, text) => {
    localStorage.setItem('cloud-timezone', 'UTC')
    open(page())
    const row = (await screen.findByText(text)).closest('tr')!
    expect(within(row).getAllByText(/۰۲:۵۶.*به وقت ایران/).length).toBeGreaterThan(0)
    expect(within(row).getByText(/۰۲:۵۵.*به وقت ایران/)).toBeTruthy()
    expect(row.textContent).toContain('سررسید:')
    expect(row.textContent).not.toContain(posted)
  })
  it('renders another account timezone in the wallet', async () => {
    account.timezone = 'UTC'; open(<WalletPage />)
    expect(await screen.findByText(/۲۳:۲۶.*به وقت UTC/)).toBeTruthy()
  })
})
