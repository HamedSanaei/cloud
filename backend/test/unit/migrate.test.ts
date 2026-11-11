import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  pools: [] as Array<{ connect: Mock; end: Mock; on: Mock }>,
  clients: [] as Array<{ query: Mock; release: Mock; locked: boolean }>,
  migrate: vi.fn(), drizzle: vi.fn(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  lock: false, migrationError: undefined as Error | undefined, connectError: undefined as Error | undefined,
}))
vi.mock('pg', () => ({ default: { Pool: class {
  connect = vi.fn(async () => {
    if (mocks.connectError) throw mocks.connectError
    const client = {
      locked: false,
      on: vi.fn(),
      query: vi.fn(async (text: string) => {
        if (text.includes('pg_try_advisory_lock')) {
          if (mocks.lock) return { rows: [{ acquired: false }] }
          mocks.lock = true
          client.locked = true
          return { rows: [{ acquired: true }] }
        }
        return { rows: [] }
      }),
      release: vi.fn(() => { if (client.locked) mocks.lock = false; client.locked = false }),
    }
    mocks.clients.push(client)
    return client
  })
  end = vi.fn(async () => undefined)
  on = vi.fn()
  constructor() { mocks.pools.push(this) }
} } }))
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: mocks.drizzle }))
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: mocks.migrate }))
vi.mock('../../src/logger.js', () => ({ createLogger: () => mocks.logger }))
// Migration behavior is independent of local provider/TOML configuration.
vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(),
  getConfig: () => ({ DATABASE_URL: 'postgres://fixture:fixture@localhost/test' }),
}))
import { migrate } from '../../src/db/migrate.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.pools.length = 0
  mocks.clients.length = 0
  mocks.lock = false
  mocks.connectError = undefined
  mocks.migrationError = undefined
  mocks.drizzle.mockImplementation((client) => ({ client }))
  mocks.migrate.mockImplementation(async ({ client }) => {
    expect(client.locked).toBe(true)
    if (mocks.migrationError) throw mocks.migrationError
  })
})
afterEach(() => vi.useRealTimers())

describe('migration session locking and cleanup', () => {

  it('does not start a second migration while the first owns its session lock', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let active = 0
    let peak = 0
    mocks.migrate.mockImplementation(async ({ client }) => {
      expect(client.locked).toBe(true)
      active++
      peak = Math.max(peak, active)
      entered.resolve()
      await gate.promise
      active--
    })
    const first = migrate()
    await entered.promise
    const contended = Promise.withResolvers<void>()
    mocks.logger.warn.mockImplementationOnce(() => { contended.resolve() })
    const second = migrate()
    await contended.promise
    expect(mocks.migrate).toHaveBeenCalledTimes(1)
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'migration_lock_busy' }), expect.any(String))
    gate.resolve()
    await first
    await vi.runAllTimersAsync()
    await second
    expect(peak).toBe(1)
    expect(mocks.migrate).toHaveBeenCalledTimes(2)
    expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true)
    expect(mocks.clients.every((client) => client.release.mock.calls.length === 1)).toBe(true)
  })

  it('propagates SQL/auth errors once and destroys the failed migration session', async () => {
    const error = Object.assign(new Error('SQL private data'), { code: '42601' })
    mocks.migrationError = error
    await expect(migrate()).rejects.toBe(error)
    expect(mocks.migrate).toHaveBeenCalledTimes(1)
    expect(mocks.clients[0]!.release).toHaveBeenCalledWith(true)
    expect(mocks.pools[0]!.end).toHaveBeenCalledOnce()
    expect(mocks.lock).toBe(false)
  })
  it('retries a lost migration connection only after destroying the failed locked session', async () => {
    mocks.migrate.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }))
    const result = migrate()
    await vi.runAllTimersAsync()
    await result
    expect(mocks.migrate).toHaveBeenCalledTimes(2)
    expect(mocks.clients).toHaveLength(2)
    expect(mocks.clients.every((client) => client.release.mock.calls.length === 1 && !client.locked)).toBe(true)
    expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true)
  })

  it('fails PostgreSQL authentication once rather than hiding it behind recovery', async () => {
    const error = Object.assign(new Error('bad password'), { code: '28P01' })
    mocks.connectError = error
    await expect(migrate()).rejects.toBe(error)
    expect(mocks.pools).toHaveLength(1)
    expect(mocks.pools[0]!.end).toHaveBeenCalledOnce()
    expect(mocks.migrate).not.toHaveBeenCalled()
  })

  it('bounds unavailable PostgreSQL attempts and closes every failed pool', async () => {
    const error = Object.assign(new Error('connection refused private URL'), { code: 'ECONNREFUSED' })
    mocks.connectError = error
    const result = migrate().catch((failure: unknown) => failure)
    await vi.runAllTimersAsync()
    expect(await result).toBe(error)
    expect(mocks.pools).toHaveLength(12)
    expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true)
    expect(mocks.migrate).not.toHaveBeenCalled()
  })
})
