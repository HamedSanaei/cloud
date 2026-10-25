import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/lib/errors.js'
import { isTemporaryStartupError, retryStartup, startupFailure } from '../../src/lib/startup.js'

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const temporary = () => Object.assign(new Error('postgres://private:password@host/db SQL secret'), { code: 'ECONNREFUSED' })
afterEach(() => vi.useRealTimers())

describe('bounded sequential startup retries', () => {
  it('backs off exponentially with a cap and recovers without overlapping attempts', async () => {
    vi.useFakeTimers()
    const log = logger()
    let active = 0
    let peak = 0
    let calls = 0
    const run = retryStartup('postgres', async () => {
      active++
      peak = Math.max(peak, active)
      try {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 20)
        await promise
        if (++calls < 5) throw temporary()
        return 'ready'
      } finally { active-- }
    }, log, { attempts: 5, initialDelayMs: 100, maxDelayMs: 250 })
    await vi.runAllTimersAsync()
    await expect(run).resolves.toBe('ready')
    expect(peak).toBe(1)
    expect(log.warn.mock.calls.map(([fields]) => fields.delayMs)).toEqual([100, 200, 250, 250])
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'startup_ready', attempt: 5 }), expect.any(String))
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('password')
  })

  it('propagates the original final error after the exact attempt budget', async () => {
    const error = temporary()
    const operation = vi.fn().mockRejectedValue(error)
    const log = logger()
    await expect(retryStartup('redis', operation, log, { attempts: 3, initialDelayMs: 0 })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ exhausted: true, attempt: 3 }), expect.any(String))
  })

  it.each([
    Object.assign(new Error('bad password'), { code: '28P01' }),
    Object.assign(new Error('missing schema'), { code: '42P01' }),
    Object.assign(new Error('invalid migration'), { code: '42601' }),
    new Error('Invalid environment configuration'),
    new Error('WRONGPASS invalid username-password pair'),
    new AppError(503, 'platform_contract', 'wrong version'),
    new AppError(503, 'platform_features_missing', 'missing feature'),
    new AppError(503, 'platform_feature_probe_failed', 'bad auth protection'),
    new AppError(503, 'platform_configuration', 'bad origin'),
    new AppError(401, 'unauthorized', 'invalid auth'),
    new AppError(401, 'platform_unavailable', 'authentication must not be retried'),
  ])('does not retry permanent startup failures: %s', async (error) => {
    const operation = vi.fn().mockRejectedValue(error)
    await expect(retryStartup('startup', operation, logger(), { initialDelayMs: 0 })).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('retries only transport/unavailable errors through Drizzle causes and aggregate errors', () => {
    expect(isTemporaryStartupError(new Error('query failed', { cause: temporary() }))).toBe(true)
    expect(isTemporaryStartupError(new AggregateError([temporary(), temporary()]))).toBe(true)
    expect(isTemporaryStartupError(new AggregateError([temporary(), new Error('schema invalid')]))).toBe(false)
    expect(isTemporaryStartupError(new AppError(503, 'platform_unavailable', 'offline'))).toBe(true)
    expect(isTemporaryStartupError(new Error('LOADING Redis is loading'))).toBe(true)
    expect(isTemporaryStartupError(Object.assign(new Error('protocol broken'), { code: '08P01' }))).toBe(false)
    expect(startupFailure(Object.assign(new Error('secret'), { code: 'secret-password' }))).toEqual({ failure: 'permanent', code: 'startup_error' })
  })
})
