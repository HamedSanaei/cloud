import { ProviderPermanentError, ProviderUnknownError } from '../../../lib/errors.js'
import type { MutatingOutcome } from './client.js'

/** Provider payloads are untrusted; never persist echoed credentials. */
export function sanitizeLeasewebPayload(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let result = value
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]')
    return result
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeLeasewebPayload(entry, secrets))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/api[_-]?key|api[_-]?token|authorization|password|secret|credential|x-lsw-auth|access[_-]?token/i.test(key)) continue
      result[key] = sanitizeLeasewebPayload(entry, secrets)
    }
    return result
  }
  return value
}

export function requireMutationSuccess(outcome: MutatingOutcome): unknown {
  if (outcome.kind === 'definitive_rejection') {
    throw new ProviderPermanentError(outcome.message, { status: outcome.status, providerCorrelationId: outcome.correlationId, requestId: outcome.requestId })
  }
  if (outcome.kind === 'unknown') {
    throw new ProviderUnknownError(outcome.message, { httpStatus: outcome.status, providerCorrelationId: outcome.correlationId, requestId: outcome.requestId })
  }
  return outcome.data
}
