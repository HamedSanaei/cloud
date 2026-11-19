import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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

  it('moves between RTL method tabs and clears passwords and visibility in both navigation directions', () => {
    render(<MemoryRouter initialEntries={['/register']}><Routes>
      <Route path="/register" element={<AuthPage key="register" intent="register" />} />
      <Route path="/login" element={<AuthPage key="login" intent="login" />} />
    </Routes></MemoryRouter>)
    const phone = screen.getByRole('tab', { name: 'ثبت‌نام با شماره همراه' })
    phone.focus()
    fireEvent.keyDown(phone, { key: 'ArrowLeft' })
    const email = screen.getByRole('tab', { name: 'ثبت‌نام با ایمیل' })
    expect(email.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(email)
    const password = () => document.querySelector<HTMLInputElement>('.password-input input')!
    fireEvent.change(password(), { target: { value: 'registration password' } })
    fireEvent.change(screen.getByLabelText('تکرار رمز عبور'), { target: { value: 'registration password' } })
    fireEvent.click(screen.getByRole('button', { name: 'نمایش رمز عبور' }))
    expect(screen.getByRole('button', { name: 'پنهان کردن رمز عبور' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'وارد شوید' }))
    expect([password().value, password().type]).toEqual(['', 'password'])
    fireEvent.change(password(), { target: { value: 'login password' } })
    fireEvent.click(screen.getByRole('link', { name: 'ثبت‌نام کنید' }))
    fireEvent.click(screen.getByRole('tab', { name: 'ثبت‌نام با ایمیل' }))
    expect([password().value, password().type, (screen.getByLabelText('تکرار رمز عبور') as HTMLInputElement).value]).toEqual(['', 'password', ''])
  })

  it('validates phone recovery locally, submits only on confirmation, and opens phone-password login', async () => {
    const fetcher = vi.fn(async (path: string) => path.endsWith('/forgot/phone')
      ? Response.json({ data: { challengeToken: 'recovery-test', challengeType: 'sms', destination: '09123***789', expiresIn: 300, resendAfter: 45 } })
      : Response.json({ data: { ok: true } }))
    vi.stubGlobal('fetch', fetcher)
    render(<MemoryRouter initialEntries={['/forgot-password?method=phone']}><Routes>
      <Route path="/forgot-password" element={<AuthPage key="forgot" intent="forgot" />} />
      <Route path="/login" element={<AuthPage key="login" intent="login" />} />
    </Routes></MemoryRouter>)
    expect(screen.getByText(/با پیامک به شماره/)).toBeTruthy()
    const phone = screen.getByPlaceholderText('09123456789')
    fireEvent.change(phone, { target: { value: '۰۹۱' } })
    fireEvent.submit(phone.closest('form')!)
    expect(screen.getByRole('alert').textContent).toContain('شماره همراه ایرانی را کامل وارد کنید')
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.change(phone, { target: { value: '۰۹۱۲۳۴۵۶۷۸۹' } })
    fireEvent.submit(phone.closest('form')!)
    fireEvent.change(await screen.findByLabelText('کد تأیید ۶ رقمی'), { target: { value: '123456' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'ثبت رمز عبور جدید' }))
    expect(screen.getByText(/رمز جدید باید ۸ تا ۲۰۰ نویسه/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('رمز عبور جدید'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('تکرار رمز جدید'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'ثبت رمز عبور جدید' }))
    expect(await screen.findByText(/رمز عبور تغییر کرد/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ورود با کد پیامکی' })).toBeTruthy()
    expect((document.querySelector('.password-input input') as HTMLInputElement).value).toBe('')
    expect(screen.queryByText('ورود موفقیت‌آمیز')).toBeNull()
  })
})
