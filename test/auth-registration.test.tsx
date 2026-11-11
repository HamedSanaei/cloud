import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthPage } from '../src/pages/AuthPages'

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({ acceptSession: vi.fn() }),
}))

describe('account registration options', () => {
  it('defaults to verified phone registration and allows optional email-only registration', () => {
    render(<MemoryRouter><AuthPage intent="register" /></MemoryRouter>)
    expect(screen.getByPlaceholderText('09123456789')).toBeTruthy()
    expect(screen.queryByPlaceholderText('example@email.com')).toBeNull()
    expect(screen.queryByLabelText('تکرار رمز عبور')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /ثبت‌نام با ایمیل/ }))
    expect(screen.getByPlaceholderText('example@email.com')).toBeTruthy()
    expect(screen.queryByPlaceholderText('09123456789')).toBeNull()
    expect(screen.getByLabelText('تکرار رمز عبور')).toBeTruthy()
  })

  it('keeps email/password login available and lets a user switch to mobile login', () => {
    render(<MemoryRouter><AuthPage intent="login" /></MemoryRouter>)
    expect(screen.getByPlaceholderText('example@email.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /شماره همراه/ }))
    expect(screen.getByPlaceholderText('09123456789')).toBeTruthy()
  })
})
