import { Redis } from 'ioredis'
import { createDb } from '../db/index.js'
import { getConfig } from '../config.js'
import type { Logger } from '../logger.js'
import { AppError } from './errors.js'
import { assertPlatformCompatibility } from '../modules/integration/platform.js'

const transientCodes: Record<string, true | undefined> = {
  ECONNREFUSED: true, ECONNRESET: true, ECONNABORTED: true, EPIPE: true, ETIMEDOUT: true,
  EAI_AGAIN: true, ENOTFOUND: true, ENETUNREACH: true, EHOSTUNREACH: true,
  UND_ERR_CONNECT_TIMEOUT: true, UND_ERR_SOCKET: true, UND_ERR_HEADERS_TIMEOUT: true, UND_ERR_BODY_TIMEOUT: true,
  '08000': true, '08001': true, '08003': true, '08006': true, '08007': true,
  '53300': true, '57P01': true, '57P02': true, '57P03': true, migration_lock_busy: true,
}
const platformPermanentCodes: Record<string, true | undefined> = {
  platform_configuration: true, platform_contract: true, platform_features_missing: true, platform_feature_probe_failed: true,
}

/** Classify narrowly: a 503 alone never makes a broken contract retryable. */
export function isTemporaryStartupError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'platform_unavailable' && [502, 503, 504].includes(error.status)
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(isTemporaryStartupError)
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: string }).code
  if (code) return transientCodes[code] === true
  if (error.cause) return isTemporaryStartupError(error.cause)
  return error.name === 'TimeoutError' || /^(Connection terminated unexpectedly|Connection terminated|timeout expired|Connection timeout|Command timed out|Query read timeout|Client has encountered a connection error and is not queryable)$/.test(error.message)
    || /^(LOADING|MASTERDOWN|CLUSTERDOWN|TRYAGAIN)\b/.test(error.message)
}

/** Never log exception messages, SQL, URLs, causes or response bodies. */
export function startupFailure(error: unknown): { failure: string; code: string } {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined
  return {
    failure: isTemporaryStartupError(error) ? 'temporary' : 'permanent',
    code: code && (transientCodes[code] === true || platformPermanentCodes[code] === true || code === 'platform_unavailable' || ['28P01', '28000', '3D000', '42P01', '42703', '42601', '23505', '42501'].includes(code)) ? code : 'startup_error',
  }
}

export async function retryStartup<T>(stage: string, operation: () => Promise<T>, logger: Pick<Logger, 'warn' | 'info' | 'error'>, options: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number } = {}): Promise<T> {
  const attempts = options.attempts ?? 12
  const initialDelayMs = options.initialDelayMs ?? 1_000
  const maxDelayMs = options.maxDelayMs ?? 10_000
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(initialDelayMs) || initialDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) throw new Error('Invalid startup retry policy')
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await operation()
      logger.info({ event: 'startup_ready', stage, attempt }, 'startup dependency ready')
      return result
    } catch (error) {
      const failure = startupFailure(error)
      if (!isTemporaryStartupError(error) || attempt >= attempts) {
        logger.error({ event: 'startup_failed', stage, attempt, exhausted: attempt >= attempts, ...failure }, 'startup dependency failed')
        throw error
      }
      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs)
      logger.warn({ event: 'startup_retry', stage, attempt, nextAttempt: attempt + 1, delayMs, ...failure }, 'retrying startup dependency')
      // Await the operation's rejection/cleanup AND this delay before another attempt.
      if (delayMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, delayMs)
        await promise
      }
    }
  }
}

async function probeRedis(): Promise<void> {
  const connection = new Redis(getConfig().REDIS_URL, {
    lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1,
    enableOfflineQueue: false, enableReadyCheck: false, connectTimeout: 3_000, commandTimeout: 3_000,
  })
  let connectionError: Error | undefined
  connection.on('error', (error: Error) => { connectionError = error })
  try {
    try { await connection.connect() } catch (error) { throw connectionError ?? error }
    if (await connection.ping() !== 'PONG') throw new Error('Unexpected Redis readiness response')
  } finally {
    connection.disconnect()
  }
}

/** These checks precede migration side effects, queues, workers and HTTP listen. */
export async function waitForStartupDependencies(logger: Logger): Promise<void> {
  await retryStartup('postgres', async () => {
    const handle = createDb()
    const probe = { text: 'select 1', query_timeout: 3_000 }
    try { await handle.pool.query(probe) } finally { await handle.pool.end() }
  }, logger)
  await retryStartup('redis', probeRedis, logger)
  await retryStartup('platform', assertPlatformCompatibility, logger)
}
