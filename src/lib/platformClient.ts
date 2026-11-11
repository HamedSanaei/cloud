import { apiGet, apiPost, isApiConfigured } from './apiClient'

export interface IntegrationStatus { enabled: boolean; linked: boolean; platformUserId?: string | null }
type Data<T> = { data: T }

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  if (!isApiConfigured()) return { enabled: false, linked: false }
  return (await apiGet<Data<IntegrationStatus>>('/integration/status')).data
}

export async function platformGet<T>(path: string): Promise<T> {
  return (await apiGet<Data<T>>(`/platform${path}`, { timeoutMs: 50000 })).data
}

export async function platformPost<T>(path: string, body: unknown, key: string = crypto.randomUUID()): Promise<T> {
  return (await apiPost<Data<T>>(`/platform${path}`, body, { headers: { 'idempotency-key': key }, timeoutMs: 50000 })).data
}
