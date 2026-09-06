export function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined
  if (!raw) return ''
  return raw.replace(/\/$/, '')
}

export function isApiConfigured(): boolean {
  return getApiBaseUrl().length > 0
}

function getAuthToken(): string {
  const fromEnv = import.meta.env.VITE_API_TOKEN as string | undefined
  if (fromEnv) return fromEnv
  try {
    return localStorage.getItem('cloud-api-token') ?? ''
  } catch {
    return ''
  }
}

export function setAuthToken(token: string): void {
  try {
    if (token) localStorage.setItem('cloud-api-token', token)
    else localStorage.removeItem('cloud-api-token')
  } catch {
    // storage unavailable (private mode) — auth header simply won't be sent
  }
}

export function clearAuthToken(): void {
  setAuthToken('')
}

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  timeoutMs?: number
}

function getTimeoutMs(): number {
  const raw = import.meta.env.VITE_API_TIMEOUT_MS as string | undefined
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = getApiBaseUrl()
  if (!baseUrl) throw new ApiError('API پیکربندی نشده است (VITE_API_BASE_URL).', 0)

  const { body, timeoutMs = getTimeoutMs(), headers, ...rest } = options
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const token = getAuthToken()
    const response = await fetch(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const contentType = response.headers.get('content-type') ?? ''
    const isJson = contentType.includes('application/json')
    const payload: unknown = isJson ? await response.json().catch(() => null) : await response.text().catch(() => '')

    if (!response.ok) {
      const message =
        (payload as { message?: string } | null)?.message ??
        (typeof payload === 'string' && payload ? payload : `خطای سرور (${response.status})`)
      throw new ApiError(message || `خطای سرور (${response.status})`, response.status, payload)
    }

    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('اتصال به سرور زمان‌بر شد. دوباره تلاش کنید.', 0)
    }
    throw new ApiError('اتصال به سرور برقرار نشد.', 0)
  } finally {
    window.clearTimeout(timer)
  }
}

export function apiGet<T>(path: string, options?: RequestOptions): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'GET' })
}

export function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'POST', body })
}

export function apiPut<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PUT', body })
}

export function apiPatch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PATCH', body })
}

export function apiDelete<T>(path: string, options?: RequestOptions): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'DELETE' })
}
