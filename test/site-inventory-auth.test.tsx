import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { IntegrationNotice } from '../src/components/layout/IntegrationNotice'

const { status } = vi.hoisted(() => ({ status: vi.fn() }))

vi.mock('../src/hooks/useApiQuery', () => ({
  useApiQuery: status,
}))

describe('website-only inventory needs no Telegram identity', () => {
  it('hides the Telegram-connect notice when site is canonical', () => {
    status.mockReturnValue({ loading: false, error: null, data: { enabled: false, linked: false }, refetch: vi.fn() })
    render(<MemoryRouter><IntegrationNotice /></MemoryRouter>)
    expect(screen.queryByText(/حساب تلگرام خود را متصل کنید/)).toBeNull()
  })

  it('keeps the optional Telegram notice only in legacy platform mode', () => {
    status.mockReturnValue({ loading: false, error: null, data: { enabled: true, linked: false }, refetch: vi.fn() })
    render(<MemoryRouter><IntegrationNotice /></MemoryRouter>)
    expect(screen.getByText(/حساب تلگرام خود را متصل کنید/)).toBeTruthy()
  })
})
