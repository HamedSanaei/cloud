import { apiGet, apiPost, clearAuthToken, setAuthToken } from './apiClient'

export interface AuthUser {
  id: string
  email: string
  role: 'user' | 'admin'
  status: 'active' | 'pending' | 'disabled'
  firstName?: string | null
  lastName?: string | null
  mobile?: string | null
  twoFactorEnabled?: boolean
}

export interface AuthSession {
  user: AuthUser
  token: string
}

export interface AuthChallenge {
  challengeToken: string
  challengeType: 'email' | 'sms' | 'totp'
  destination: string
  expiresIn: number
  resendAfter: number
  developmentCode?: string
}

type Data<T> = { data: T }

export async function getCurrentUser(): Promise<AuthUser> {
  return (await apiGet<Data<AuthUser>>('/auth/me')).data
}

export async function startEmailLogin(email: string, password: string): Promise<AuthChallenge> {
  return (await apiPost<Data<AuthChallenge>>('/auth/login/start', { email, password })).data
}

export async function startRegistration(input: { email: string; password: string; firstName?: string; lastName?: string }): Promise<AuthChallenge> {
  return (await apiPost<Data<AuthChallenge>>('/auth/register/start', input)).data
}

export async function startPhoneLogin(mobile: string): Promise<AuthChallenge> {
  return (await apiPost<Data<AuthChallenge>>('/auth/phone/start', { mobile })).data
}

export async function verifyChallenge(token: string, code: string): Promise<AuthSession> {
  const session = (await apiPost<Data<AuthSession>>('/auth/challenge/verify', { token, code })).data
  setAuthToken(session.token)
  return session
}

export async function verifyTotpChallenge(token: string, code: string): Promise<AuthSession> {
  const session = (await apiPost<Data<AuthSession>>('/auth/2fa/verify', { token, code })).data
  setAuthToken(session.token)
  return session
}

export async function verifyRecoveryCode(token: string, recoveryCode: string): Promise<AuthSession> {
  const session = (await apiPost<Data<AuthSession>>('/auth/2fa/recovery', { token, recoveryCode })).data
  setAuthToken(session.token)
  return session
}

export async function resendChallenge(token: string): Promise<AuthChallenge> {
  return (await apiPost<Data<AuthChallenge>>('/auth/challenge/resend', { token })).data
}

export async function startPasswordRecovery(email: string): Promise<AuthChallenge> {
  return (await apiPost<Data<AuthChallenge>>('/auth/password/forgot', { email })).data
}

export async function resetPassword(token: string, code: string, password: string): Promise<void> {
  await apiPost('/auth/password/reset', { token, code, password })
}

export async function getGoogleLoginUrl(redirectTo = '/dashboard'): Promise<string> {
  const payload = await apiGet<Data<{ url: string }>>(`/auth/google/start?redirectTo=${encodeURIComponent(redirectTo)}`)
  return payload.data.url
}

export async function logoutSession(): Promise<void> {
  try {
    await apiPost('/auth/logout', {})
  } finally {
    clearAuthToken()
  }
}

export interface TwoFactorSetup {
  secret: string
  otpAuthUri: string
  recoveryCodes: string[]
}

export async function setupTwoFactor(): Promise<TwoFactorSetup> {
  return (await apiPost<Data<TwoFactorSetup>>('/auth/2fa/setup', {})).data
}

export async function enableTwoFactor(code: string): Promise<void> {
  await apiPost('/auth/2fa/enable', { code })
}

export async function disableTwoFactor(password: string): Promise<void> {
  await apiPost('/auth/2fa/disable', { password })
}
