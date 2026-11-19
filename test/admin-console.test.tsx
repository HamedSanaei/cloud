import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminLayout } from '../src/admin/AdminLayout'
import { AdminOverview, AdminUserPage } from '../src/admin/AdminPages'

const { getAuth, query } = vi.hoisted(() => ({
  getAuth: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: getAuth,
}))
vi.mock('../src/hooks/useApiQuery', () => ({ useApiQuery: query }))

function renderAdmin() {
  return render(<MemoryRouter initialEntries={['/admin']}>
    <Routes><Route path="/admin" element={<AdminLayout />}>
      <Route index element={<AdminOverview />} />
    </Route></Routes>
  </MemoryRouter>)
}

describe('Penpot admin console access and real API states', () => {
  it('shows the existing sign-in form for an unauthenticated /admin visit', () => {
    getAuth.mockReturnValue({ user: null, loading: false, acceptSession: vi.fn() })
    renderAdmin()
    expect(screen.getByText('ورود به پنل مدیریت')).toBeTruthy()
    expect(screen.getByPlaceholderText('example@email.com')).toBeTruthy()
  })

  it('does not render private data to a signed-in normal user', () => {
    getAuth.mockReturnValue({ user: { id: 'u1', email: 'customer@example.test', role: 'user', status: 'active' }, loading: false })
    renderAdmin()
    expect(screen.getByText('دسترسی به پنل مدیریت مجاز نیست')).toBeTruthy()
    expect(screen.queryByText('مبلغ سفارش‌های پرداخت‌شده')).toBeNull()
  })

  it('renders website overview for an authenticated admin without sample data', () => {
    getAuth.mockReturnValue({ user: { id: 'a1', email: 'admin@example.test', role: 'admin', status: 'active' }, loading: false })
    query.mockReturnValue({ data: {
      source: 'website', accounts: [{ role: 'user', status: 'active', count: 6 }, { role: 'admin', status: 'active', count: 1 }],
      orderCounts: { active: 3 }, serverCounts: { active: 2, terminated: 2 },
      checkedAt: '2026-11-19T14:13:00Z', overdue: 0, failedRenewals24h: 1, ordersNeedingAttention: 1,
      finance: { initialRial: 1200000, renewalRial: 50000, refundsRial: 0, netRial: 1250000, depositsRial: 1500000, exceptionCount: 0, renewalMismatchCount: 0, exceptions: [] },
      recentOrders: [{ id: 'o1', orderNumber: 'ORD-1', userName: 'آزمایشی', totalToman: 120000, status: 'active', serverStatus: 'terminated' }],
    }, loading: false, error: null, refetch: vi.fn() })
    renderAdmin()
    expect(screen.getByText('خرید اولیهٔ پذیرفته‌شده، ناخالص')).toBeTruthy()
    const row = within(screen.getByRole('link', { name: 'ORD-1' }).closest('tr')!)
    expect(row.getByText('تحویل‌شده')).toBeTruthy()
    expect(row.getByText('حذف‌شده')).toBeTruthy()
  })

  it('uses the same credit and debit columns in a user’s read-only ledger', () => {
    const row = { walletId: 'w1', type: 'purchase', amountRial: -1500000, amountToman: -150000, createdAt: '2026-11-14T12:00:00Z' }
    query.mockReturnValue({ data: {
      user: { id: 'u1', email: 'customer@example.test', status: 'active', createdAt: row.createdAt }, balanceToman: 0,
      wallets: [{ id: 'w1', name: 'کیف آزمایشی', balanceToman: 0, isDefault: true }], servers: [],
      transactions: [{ ...row, id: 'purchase', description: 'هزینهٔ تعویض', referenceType: 'primary_ipv4_replacement', referenceId: 's1' },
        { ...row, id: 'refund', description: 'بازپرداخت آزمایشی', type: 'refund', amountRial: 1500000, amountToman: 150000 }],
    }, loading: false, error: null })
    render(<MemoryRouter initialEntries={['/admin/users/u1']}><Routes><Route path="/admin/users/:id" element={<AdminUserPage />} /></Routes></MemoryRouter>)
    expect(screen.getByRole('columnheader', { name: 'واریز (+)' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'برداشت (-)' })).toBeTruthy()
    const debit = within(screen.getByText('هزینهٔ تعویض').closest('tr')!)
    const credit = within(screen.getByText('بازپرداخت آزمایشی').closest('tr')!)
    expect(debit.getAllByRole('cell').slice(2, 4).map(cell => cell.textContent)).toEqual(['—', '۱۵۰,۰۰۰ تومان'])
    expect(credit.getAllByRole('cell').slice(2, 4).map(cell => cell.textContent)).toEqual(['۱۵۰,۰۰۰ تومان', '—'])
    expect(debit.getByRole('link').getAttribute('href')).toBe('/admin/servers/s1')
  })
})
