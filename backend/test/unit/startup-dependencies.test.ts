import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { AppError } from '../../src/lib/errors.js'
const testLogger = pino({ level: 'silent' })

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), ping: vi.fn(), platform: vi.fn(),
  pools: [] as Array<{ end: Mock }>, redis: [] as Array<{ disconnect: Mock }>,
  order: [] as string[],
}))
vi.mock('../../src/db/index.js', () => ({ createDb: () => {
  const pool = { query: mocks.query, end: vi.fn(async () => { mocks.order.push('postgres-close') }) }
  mocks.pools.push(pool)
  return { pool }
} }))
vi.mock('ioredis', () => ({ Redis: class {
  connect = mocks.connect
  ping = mocks.ping
  on = vi.fn()
  disconnect = vi.fn(() => { mocks.order.push('redis-close') })
  constructor() { mocks.redis.push(this) }
} }))
vi.mock('../../src/modules/integration/platform.js', () => ({ assertPlatformCompatibility: mocks.platform }))
import { waitForStartupDependencies } from '../../src/lib/startup.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.pools.length = 0
  mocks.redis.length = 0
  mocks.order.length = 0
  loadConfig({ NODE_ENV: 'test' })
  mocks.query.mockImplementation(async () => { mocks.order.push('postgres-ready') })
  mocks.connect.mockImplementation(async () => { mocks.order.push('redis-connect') })
  mocks.ping.mockImplementation(async () => { mocks.order.push('redis-ready'); return 'PONG' })
  mocks.platform.mockImplementation(async () => { mocks.order.push('platform-ready') })
})
afterEach(() => vi.useRealTimers())

describe('startup dependency readiness gates', () => {

  it('closes each failed PostgreSQL probe before retrying and reaches Redis only after recovery', async () => {
    mocks.query.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }))
    const result = waitForStartupDependencies(testLogger)
    await vi.runAllTimersAsync()
    await result
    expect(mocks.pools).toHaveLength(2)
    expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true)
    expect(mocks.order[0]).toBe('postgres-close')
    expect(mocks.redis).toHaveLength(1)
  })

  it('disconnects every failed Redis attempt and never proceeds to the platform after exhaustion', async () => {
    const error = Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
    mocks.connect.mockRejectedValue(error)
    const result = waitForStartupDependencies(testLogger).catch((failure: unknown) => failure)
    await vi.runAllTimersAsync()
    expect(await result).toBe(error)
    expect(mocks.redis).toHaveLength(12)
    expect(mocks.redis.every((connection) => connection.disconnect.mock.calls.length === 1)).toBe(true)
    expect(mocks.platform).not.toHaveBeenCalled()
  })

  it('propagates authentication and platform contract failures immediately with no leaked probes', async () => {
    const error = new Error('WRONGPASS invalid username-password pair')
    mocks.connect.mockRejectedValueOnce(error)
    await expect(waitForStartupDependencies(testLogger)).rejects.toBe(error)
    expect(mocks.redis).toHaveLength(1)
    expect(mocks.redis[0]!.disconnect).toHaveBeenCalledOnce()
    expect(mocks.platform).not.toHaveBeenCalled()
    const contract = new AppError(503, 'platform_features_missing', 'unsupported')
    mocks.platform.mockRejectedValueOnce(contract)
    await expect(waitForStartupDependencies(testLogger)).rejects.toBe(contract)
    expect(mocks.platform).toHaveBeenCalledOnce()
    expect(mocks.redis.every((connection) => connection.disconnect.mock.calls.length === 1)).toBe(true)
  })
})
