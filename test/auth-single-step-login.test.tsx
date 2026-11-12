import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthPage } from '../src/pages/AuthPages'

const { acceptSession, startEmailLogin } = vi.hoisted(() => ({
  acceptSession: vi.fn(),
  startEmailLogin: vi.fn(),
}))

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({ acceptSession }),
}))

vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/auth')>(),
  startEmailLogin,
}))

afterEach(() => {
  vi.clearAllMocks()
})

function submitPasswordLogin(adminEntry: boolean) {
  render(<MemoryRouter><AuthPage intent="login" adminEntry={adminEntry} /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('example@email.com'), { target: { value: 'user@example.test' } })
  fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'CorrectPassword123!' } })
  fireEvent.click(screen.getByRole('button', { name: 'ورود به حساب' }))
}

describe('single-step password login in the shared user/admin UI', () => {
  it.each([false, true])('signs into %s admin entry without showing a one-time-code screen', async (adminEntry) => {
    const session = { user: { id: 'u-1', email: 'user@example.test', role: adminEntry ? 'admin' : 'user', status: 'active' }, token: 'cls_test_token' }
    startEmailLogin.mockResolvedValue(session)
    submitPasswordLogin(adminEntry)

    await waitFor(() => expect(acceptSession).toHaveBeenCalledWith(session))
    expect(screen.getByText('ورود موفقیت‌آمیز')).toBeTruthy()
    expect(screen.queryByText('کد تأیید ۶ رقمی')).toBeNull()
    expect(startEmailLogin).toHaveBeenCalledWith('user@example.test', 'CorrectPassword123!')
  })

  it('rejects invalid credentials instead of offering an OTP bypass', async () => {
    startEmailLogin.mockRejectedValue(new Error('ایمیل یا رمز عبور نادرست است'))
    submitPasswordLogin(false)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'ایمیل یا رمز عبور نادرست است')
    expect(acceptSession).not.toHaveBeenCalled()
    expect(screen.queryByText('کد تأیید ۶ رقمی')).toBeNull()
  })
})
