import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminLayout } from '../src/admin/AdminLayout'
import { AdminOverview } from '../src/admin/AdminPages'

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
      source: 'website', users: 7, orders: 3, servers: 4, activeServers: 2,
      ordersNeedingAttention: 1, paidOrderTotalRial: 1200000, paidOrderTotalToman: 120000,
      recentOrders: [],
    }, loading: false, error: null, refetch: vi.fn() })
    renderAdmin()
    expect(screen.getByText('مبلغ سفارش‌های پرداخت‌شده')).toBeTruthy()
    expect(screen.getByText('۱۲۰,۰۰۰')).toBeTruthy()
    expect(screen.getByText('هنوز سفارشی ثبت نشده است.')).toBeTruthy()
  })
})
