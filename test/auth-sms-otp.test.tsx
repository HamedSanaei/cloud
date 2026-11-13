import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthPage } from '../src/pages/AuthPages'
import { ApiError } from '../src/lib/apiClient'

const { acceptSession, startPhoneRegistration, verifyChallenge } = vi.hoisted(() => ({
  acceptSession: vi.fn(), startPhoneRegistration: vi.fn(), verifyChallenge: vi.fn(),
}))
vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ acceptSession }) }))
vi.mock('../src/lib/auth', async original => ({
  ...await original<typeof import('../src/lib/auth')>(), startPhoneRegistration, verifyChallenge,
}))
beforeEach(() => {
  vi.resetAllMocks()
  startPhoneRegistration.mockResolvedValue({ challengeToken: 'fixture-challenge', challengeType: 'sms', destination: 'masked', resendAfter: 60, expiresIn: 300 })
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
