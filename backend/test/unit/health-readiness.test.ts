import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { registerHealthRoutes } from '../../src/modules/health/routes.js'

afterEach(() => vi.unstubAllGlobals())

describe('production unified readiness', () => {
  it('does not call missing authentication credentials healthy just because the DB is reachable', async () => {
    loadConfig({ NODE_ENV: 'production', PLATFORM_API_URL: 'http://cloud-platform-api:8000',
      FRONTEND_URL: 'https://console.example.test', AUTH_DELIVERY_MODE: 'live' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = Fastify()
    await app.register(registerHealthRoutes, { prefix: '/api', ctx: { db: { execute: vi.fn().mockResolvedValue([]) } } as unknown as AppContext })
    const response = await app.inject('/api/health/ready')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'error', checks: { database: 'ok', authentication: 'error' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await app.inject('/api/health/live')).statusCode).toBe(200)
    await app.close()
  })
})
