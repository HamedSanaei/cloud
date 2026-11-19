import { apiPost } from './apiClient'

export type EmailProof = { token: string; code: string }
export type EmailChallenge = { token: string; destination: string; expiresIn: number; resendAfter: number }
export type OperationIntent = {
  action: 'create' | 'delete' | 'reset_password' | 'platform_order' | 'platform_delete' | 'platform_reset_password'
  key: string
  payload: Record<string, unknown>
}
export const operationHeaders = (proof?: EmailProof): Record<string, string> => proof
  ? { 'x-operation-token': proof.token, 'x-operation-code': proof.code } : {}

export const startOperationEmail = async (intent: OperationIntent) =>
  (await apiPost<{ data: EmailChallenge }>('/auth/operation-email/start', intent)).data
export const cancelOperationEmail = (token: string) => apiPost('/auth/operation-email/cancel', { token })
export const startAccountEmail = async (email: string) =>
  (await apiPost<{ data: EmailChallenge }>('/auth/account-email/start', { email })).data
export const verifyAccountEmail = (proof: EmailProof) => apiPost('/auth/account-email/verify', proof)
