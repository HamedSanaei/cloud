import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthPage } from '../src/pages/AuthPages'
import { ApiError } from '../src/lib/apiClient'

const { acceptSession, startPhoneRegistration, startPhoneLogin, resendChallenge, verifyChallenge } = vi.hoisted(() => ({
  acceptSession: vi.fn(), startPhoneRegistration: vi.fn(), startPhoneLogin: vi.fn(), resendChallenge: vi.fn(), verifyChallenge: vi.fn(),
}))
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ acceptSession }) }))
vi.mock('../src/lib/auth', async original => ({
  ...await original<typeof import('../src/lib/auth')>(), startPhoneRegistration, startPhoneLogin, resendChallenge, verifyChallenge,
}))
beforeEach(() => {
  vi.resetAllMocks()
  startPhoneRegistration.mockResolvedValue({ challengeToken: 'fixture-challenge', challengeType: 'sms', destination: 'masked', resendAfter: 60, expiresIn: 300 })
})

describe('WebOTP during mobile login', () => {
  const loginChallenge = { challengeToken: 'login-otp', challengeType: 'sms', destination: 'masked', resendAfter: 0, expiresIn: 300, smsAutofill: true }
  const getCredential = vi.fn()
  const jsdom = (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom
  let originalUrl: string
  let restoreCredentials: () => void

  beforeEach(() => {
    originalUrl = window.location.href
    jsdom.reconfigure({ url: 'https://login.example.test/login' })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('OTPCredential', function () {})
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'credentials')
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: getCredential } })
    restoreCredentials = () => {
      if (descriptor) Object.defineProperty(navigator, 'credentials', descriptor)
      else Reflect.deleteProperty(navigator, 'credentials')
    }
    startPhoneLogin.mockResolvedValue(loginChallenge)
    verifyChallenge.mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    restoreCredentials()
    jsdom.reconfigure({ url: originalUrl })
    vi.useRealTimers()
  })

  function startLogin() {
    const view = render(<MemoryRouter><AuthPage intent="login" /></MemoryRouter>)
    fireEvent.click(screen.getByRole('tab', { name: 'شماره همراه' }))
    const mobile = screen.getByPlaceholderText('09123456789')
    fireEvent.change(mobile, { target: { value: '09000000000' } })
    fireEvent.submit(mobile.closest('form')!)
    return { ...view, form: mobile.closest('form')! }
  }

  it('arms before sending, buffers early arrival, and verifies once before TOTP', async () => {
    getCredential.mockResolvedValue({ code: '034567' })
    let resolveSend!: (value: typeof loginChallenge) => void
    startPhoneLogin.mockImplementation(() => {
      expect(getCredential).toHaveBeenCalledWith({ otp: { transport: ['sms'] }, signal: expect.any(AbortSignal) })
      return new Promise(resolve => { resolveSend = resolve })
    })
    verifyChallenge.mockResolvedValue({ ...loginChallenge, challengeToken: 'totp-otp', challengeType: 'totp' })
    const { form } = startLogin()
    fireEvent.submit(form)
    await act(async () => {})
    expect(startPhoneLogin).toHaveBeenCalledTimes(1)
    expect(verifyChallenge).not.toHaveBeenCalled()
    resolveSend(loginChallenge)
    expect(await screen.findByText('Google Authenticator یا برنامه مشابه')).toBeTruthy()
    expect(verifyChallenge).toHaveBeenCalledExactlyOnceWith('login-otp', '034567', expect.any(AbortSignal))
    expect(acceptSession).not.toHaveBeenCalled()
  })

  it.each(['denied', 'unsupported', 'http', 'unformatted', 'invalid code'])('allows manual paste after %s', async (mode) => {
    if (mode === 'denied') getCredential.mockRejectedValue(new DOMException('', 'NotAllowedError'))
    else getCredential.mockResolvedValue({ code: mode === 'invalid code' ? '1234567' : '034567' })
    if (mode === 'unsupported') Reflect.deleteProperty(window, 'OTPCredential')
    if (mode === 'http') jsdom.reconfigure({ url: 'http://login.example.test/login' })
    if (mode === 'unformatted') startPhoneLogin.mockResolvedValue({ ...loginChallenge, smsAutofill: undefined })
    startLogin()
    const input = await screen.findByLabelText('کد تأیید ۶ رقمی')
    if (mode === 'unsupported' || mode === 'http') expect(getCredential).not.toHaveBeenCalled()
    expect(verifyChallenge).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '۰۳۴۵۶۷' } })
    expect(verifyChallenge).toHaveBeenCalledExactlyOnceWith('login-otp', '034567', expect.any(AbortSignal))
  })

  it('expires the listener and still allows manual entry', async () => {
    vi.useFakeTimers()
    getCredential.mockReturnValue(new Promise(() => {}))
    startLogin()
    await act(async () => {})
    const signal = getCredential.mock.calls[0]![0].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(signal.aborted).toBe(true)
    expect(verifyChallenge).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('کد تأیید ۶ رقمی'), { target: { value: '034567' } })
    expect(verifyChallenge).toHaveBeenCalledTimes(1)
  })

  it('aborts stale reads and accepts a replacement code only for the resend token', async () => {
    let resolveFirst!: (value: unknown) => void
    getCredential.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ code: '654321' })
    resendChallenge.mockResolvedValue({ ...loginChallenge, challengeToken: 'replacement' })
    startLogin()
    const resend = await screen.findByRole('button', { name: 'ارسال مجدد کد' })
    fireEvent.click(resend)
    fireEvent.click(resend)
    resolveFirst({ code: '034567' })
    await waitFor(() => expect(verifyChallenge).toHaveBeenCalledExactlyOnceWith('replacement', '654321', expect.any(AbortSignal)))
    expect(getCredential.mock.calls[0]![0].signal.aborted).toBe(true)
    expect(resendChallenge).toHaveBeenCalledExactlyOnceWith('login-otp')
  })

  it.each(['manual input', 'back', 'navigation', 'send error'])('aborts on %s and ignores a late credential', async (action) => {
    let resolveRead!: (value: unknown) => void
    getCredential.mockReturnValue(new Promise(resolve => { resolveRead = resolve }))
    if (action === 'send error') startPhoneLogin.mockRejectedValue(new Error('delivery failed'))
    startLogin()
    if (action === 'send error') await screen.findByRole('alert')
    else {
      const input = await screen.findByLabelText('کد تأیید ۶ رقمی')
      if (action === 'manual input') fireEvent.change(input, { target: { value: '0' } })
      if (action === 'back') fireEvent.click(screen.getByRole('button', { name: 'اصلاح اطلاعات ورود' }))
      if (action === 'navigation') fireEvent.click(screen.getByRole('link', { name: 'پارس سرور' }))
    }
    expect(getCredential.mock.calls[0]![0].signal.aborted).toBe(true)
    await act(async () => { resolveRead({ code: '034567' }) })
    expect(verifyChallenge).not.toHaveBeenCalled()
  })
})
async function openOtp() {
  const view = render(<MemoryRouter><AuthPage intent="register" /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('09123456789'), { target: { value: '09000000000' } })
  fireEvent.click(screen.getByRole('button', { name: 'ساخت حساب' }))
  return { ...view, input: await screen.findByLabelText('کد تأیید ۶ رقمی') as HTMLInputElement }
}
describe('SMS-only automatic verification', () => {
  it.each(['۱۲۳۴۵۶', '١٢٣٤٥٦', '123456'])('normalizes %s and verifies once without submit', async value => {
    verifyChallenge.mockReturnValue(new Promise(() => {}))
    const { input, unmount } = await openOtp()
    fireEvent.change(input, { target: { value: value.slice(0, 5) } })
    expect(verifyChallenge).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value } })
    fireEvent.change(input, { target: { value } })
    expect(verifyChallenge).toHaveBeenCalledTimes(1)
    const signal = verifyChallenge.mock.calls[0]![2] as AbortSignal
    expect(verifyChallenge).toHaveBeenCalledWith('fixture-challenge', '123456', signal)
    unmount()
    expect(signal.aborted).toBe(true)
  })
  it('clears rejected codes, shows the server budget and locks after the third error', async () => {
    const { input } = await openOtp()
    for (const remaining of [2, 1, 0]) {
      verifyChallenge.mockRejectedValueOnce(new ApiError('کد نامعتبر', remaining ? 400 : 403, { details: { attemptsRemaining: remaining } }))
      fireEvent.change(input, { target: { value: '654321' } })
      await waitFor(() => expect(input.value).toBe(''))
      expect((await screen.findByRole('alert')).textContent).toContain(`${'۰۱۲'[remaining]} تلاش باقی‌مانده`)
    }
    expect(verifyChallenge).toHaveBeenCalledTimes(3)
    expect(input.disabled).toBe(true)
    expect(acceptSession).not.toHaveBeenCalled()
  })
  it.each(['email', 'totp'])('does not auto-submit %s challenges', async challengeType => {
    startPhoneRegistration.mockResolvedValue({ challengeToken: 'fixture', challengeType, destination: 'masked', resendAfter: 60 })
    const { input } = await openOtp()
    fireEvent.change(input, { target: { value: '123456' } })
    expect(verifyChallenge).not.toHaveBeenCalled()
    expect(acceptSession).not.toHaveBeenCalled()
  })
  it('does not accept a session from a late response after unmount', async () => {
    let resolve!: (value: unknown) => void
    verifyChallenge.mockReturnValue(new Promise(done => { resolve = done }))
    const { input, unmount } = await openOtp()
    fireEvent.change(input, { target: { value: '123456' } })
    unmount()
    resolve({ token: 'cls_fixture', user: { id: 'fixture' } })
    await Promise.resolve()
    expect(acceptSession).not.toHaveBeenCalled()
  })
})
