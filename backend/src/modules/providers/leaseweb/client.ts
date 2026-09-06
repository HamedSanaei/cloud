/**
 * Centralized Leaseweb HTTP client.
 *
 * - Base URL + X-LSW-Auth header handled here only.
 * - Never logs the API key (redaction is also enforced by the logger config).
 * - Every request carries a client correlation id (`X-Correlation-Id`) and
 *   captures Leaseweb's server correlation id (`APIGW-CORRELATION-ID`
 *   response header) so UNKNOWN-order investigations can hand the provider a
 *   concrete identifier.
 * - GET requests may use normal safe retries.
 * - MUTATING POST requests are classified conservatively (see below): the
 *   caller must never blind-retry a POST whose outcome may be unknown.
 */

import { randomUUID } from 'node:crypto'
import { ProviderPermanentError, ProviderRetryableError } from '../../../lib/errors.js'
import type { Logger } from '../../../logger.js'

/** Leaseweb's server-side correlation header (case-insensitive lookup). */
export const LSW_CORRELATION_HEADER = 'apigw-correlation-id'

export interface LeasewebClientOptions {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  logger: Logger
}

/** Outcome of a mutating request — the caller decides retry/review policy. */
export type MutatingOutcome =
  | { kind: 'success'; data: unknown; correlationId?: string; requestId?: string }
  | { kind: 'definitive_rejection'; status: number; message: string; correlationId?: string; requestId?: string }
  | { kind: 'unknown'; status?: number; message: string; correlationId?: string; requestId?: string }

export interface RequestMeta {
  /** Client-generated correlation id sent as X-Correlation-Id. */
  clientCorrelationId: string
  /** Leaseweb's correlation id from the APIGW-CORRELATION-ID response header. */
  providerCorrelationId?: string
}

export class LeasewebClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly logger: Logger

  constructor(opts: LeasewebClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.logger = opts.logger
  }

  get configured(): boolean {
    return this.apiKey.length > 0
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  /**
   * GET with metadata (correlation ids). Safe to retry on transient errors.
   */
  async getWithMeta<T>(path: string): Promise<{ data: T; meta: RequestMeta }> {
    return this.requestWithMeta<T>('GET', path)
  }

  /**
   * Mutating POST with conservative outcome classification. NEVER blind-retry
   * the result: `unknown` means the request may have been processed by
   * Leaseweb (timeout after transmission, connection drop, 5xx, 429 on a
   * mutating endpoint). Only `definitive_rejection` proves the provider did
   * not accept the request.
   */
  async postMutating(path: string, body: unknown): Promise<MutatingOutcome> {
    if (!this.configured) {
      return {
        kind: 'definitive_rejection',
        status: 0,
        message: 'Leaseweb API key is not configured (set LEASEWEB_API_KEY)',
      }
    }
    const correlationId = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`

    const headers: Record<string, string> = {
      'X-LSW-Auth': this.apiKey,
      Accept: 'application/json',
      'X-Correlation-Id': correlationId,
      'Content-Type': 'application/json',
    }

    this.logger.debug({ method: 'POST', path, correlationId }, 'leaseweb mutating request')

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const providerCorrelationId = readCorrelationId(res.headers)
      const text = await res.text().catch(() => '')
      const payload = parseJson(text)

      if (res.ok) {
        return { kind: 'success', data: payload, correlationId: providerCorrelationId, requestId: correlationId }
      }

      const message = extractMessage(payload) ?? `Leaseweb HTTP ${res.status}`

      if (res.status >= 500 || res.status === 429) {
        // We cannot prove whether Leaseweb processed the order. Conservative.
        this.logger.warn({ method: 'POST', path, status: res.status, correlationId, providerCorrelationId }, 'leaseweb mutating request returned ambiguous status')
        return {
          kind: 'unknown',
          status: res.status,
          message: `Leaseweb ambiguous response after mutating request (${res.status}): ${message}`,
          correlationId: providerCorrelationId,
          requestId: correlationId,
        }
      }

      // Other 4xx: Leaseweb answered with a definitive rejection.
      return {
        kind: 'definitive_rejection',
        status: res.status,
        message: `Leaseweb rejected request (${res.status}): ${message}`,
        correlationId: providerCorrelationId,
        requestId: correlationId,
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      // Network failure / timeout after transmission: the POST may have been
      // processed. Never retryable by the caller.
      this.logger.warn({ method: 'POST', path, correlationId, aborted }, 'leaseweb mutating request failed (outcome unknown)')
      return {
        kind: 'unknown',
        message: aborted ? 'Leaseweb request timed out after transmission — outcome unknown' : `Leaseweb request failed: ${(err as Error).message} — outcome unknown`,
        requestId: correlationId,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { data } = await this.requestWithMeta<T>(method, path, body)
    return data
  }

  private async requestWithMeta<T>(method: string, path: string, body?: unknown): Promise<{ data: T; meta: RequestMeta }> {
    if (!this.configured) {
      throw new ProviderPermanentError('Leaseweb API key is not configured', { hint: 'set LEASEWEB_API_KEY' })
    }
    const correlationId = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`

    const headers: Record<string, string> = {
      'X-LSW-Auth': this.apiKey,
      Accept: 'application/json',
      'X-Correlation-Id': correlationId,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    this.logger.debug({ method, path, correlationId }, 'leaseweb request')

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const providerCorrelationId = readCorrelationId(res.headers)
      const text = await res.text().catch(() => '')
      const payload = parseJson(text)

      if (res.ok) {
        return { data: payload as T, meta: { clientCorrelationId: correlationId, providerCorrelationId } }
      }

      const message = extractMessage(payload) ?? `Leaseweb HTTP ${res.status}`
      if (res.status >= 500 || res.status === 429) {
        throw new ProviderRetryableError(`Leaseweb transient error: ${message}`, {
          status: res.status,
          correlationId,
          providerCorrelationId,
        })
      }
      throw new ProviderPermanentError(`Leaseweb rejected request (${res.status}): ${message}`, {
        status: res.status,
        correlationId,
        providerCorrelationId,
      })
    } catch (err) {
      if (err instanceof ProviderPermanentError || err instanceof ProviderRetryableError) throw err
      const aborted = err instanceof Error && err.name === 'AbortError'
      this.logger.warn({ method, path, correlationId, aborted }, 'leaseweb request failed')
      throw new ProviderRetryableError(
        aborted ? 'Leaseweb request timed out' : `Leaseweb request failed: ${(err as Error).message}`,
        { correlationId },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function readCorrelationId(headers: Headers): string | undefined {
  const value = headers.get(LSW_CORRELATION_HEADER)
  if (value) return value
  // Case-insensitive fallback for gateways that vary the header case.
  const raw: unknown = headers
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    for (const [k, v] of Object.entries(rec)) {
      if (k.toLowerCase() === LSW_CORRELATION_HEADER && typeof v === 'string' && v) return v
    }
  }
  return undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function extractMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    const m = p.message ?? p.error ?? p.errorMessage
    if (typeof m === 'string') return m
    if (Array.isArray(p.error)) {
      const parts = p.error.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')
      if (parts) return parts
    }
  }
  if (typeof payload === 'string' && payload.length < 500) return payload
  return undefined
}