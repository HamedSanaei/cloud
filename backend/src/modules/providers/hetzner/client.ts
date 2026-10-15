import { ProviderPermanentError, ProviderRetryableError, ProviderUnknownError } from '../../../lib/errors.js'

export type ApiObject = Record<string, unknown>
export const object = (value: unknown): ApiObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ApiObject : {}

/** Only status/code classifications cross this boundary; never bodies or headers. */
export class HetznerApiError extends ProviderPermanentError {
  constructor(readonly httpStatus: number, readonly providerCode: string, readonly capacity: boolean) {
    super(capacity ? 'Hetzner definitively rejected the request for capacity' : 'Hetzner rejected the request', {
      httpStatus, providerCode,
    })
  }
}

export class HetznerClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch) {}

  async request(method: 'GET' | 'POST', path: string, body?: ApiObject): Promise<ApiObject> {
    let response: Response
    let payload: unknown
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      })
      payload = await response.json()
    } catch {
      if (method === 'POST') throw new ProviderUnknownError('Hetzner mutation outcome is unknown; do not submit another order')
      throw new ProviderRetryableError('Hetzner read request is unavailable')
    }
    const data = object(payload)
    if (!response.ok) {
      const rawCode = object(data.error).code
      // Allowlisted codes only: a provider error string may contain a credential.
      const knownCodes = ['resource_limit_exceeded', 'resource_unavailable', 'invalid_input', 'json_error', 'unsupported_error', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'locked', 'rate_limit_exceeded']
      const code = typeof rawCode === 'string' && knownCodes.includes(rawCode) ? rawCode : 'unclassified'
      const capacity = (response.status === 403 && code === 'resource_limit_exceeded') || (response.status === 412 && code === 'resource_unavailable')
      if (capacity) throw new HetznerApiError(response.status, code, true)
      const definitive = [401, 403, 404, 409, 423].includes(response.status)
        || (response.status === 400 && code === 'json_error')
        || (response.status === 422 && ['invalid_input', 'unsupported_error'].includes(code))
      if (method === 'POST' && !definitive) throw new ProviderUnknownError('Hetzner mutation outcome is unknown', { httpStatus: response.status })
      if (response.status === 429 || response.status >= 500 || response.status === 408) {
        throw new ProviderRetryableError('Hetzner read request is unavailable', { httpStatus: response.status })
      }
      throw new HetznerApiError(response.status, code, false)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      if (method === 'POST') throw new ProviderUnknownError('Hetzner mutation returned an invalid response')
      throw new ProviderRetryableError('Hetzner read returned an invalid response')
    }
    return data
  }

  async pages(path: string, key: string): Promise<ApiObject[]> {
    const result: ApiObject[] = []
    let page = 1
    const visited = new Set<number>()
    while (true) {
      if (visited.has(page)) throw new ProviderRetryableError('Hetzner pagination was inconsistent')
      visited.add(page)
      const data = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`)
      if (!Array.isArray(data[key])) throw new ProviderRetryableError('Hetzner read returned an invalid collection')
      result.push(...data[key].map(object))
      const pagination = object(object(data.meta).pagination)
      const next = pagination.next_page
      if (next === null || next === undefined) break
      if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= page) throw new ProviderRetryableError('Hetzner pagination was inconsistent')
      page = next
    }
    return result
  }
}
