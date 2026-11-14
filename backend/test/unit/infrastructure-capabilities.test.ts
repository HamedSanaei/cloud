import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerFrontendCompatRoutes } from '../../src/modules/frontend/routes.js'
import type { AppContext } from '../../src/app.js'
import { AppError } from '../../src/lib/errors.js'
import { loadConfig } from '../../src/config.js'
import { installPlatformIntegration } from '../../src/modules/integration/platform.js'

describe('independent infrastructure purchase capabilities', () => {
  it.each(['site', 'platform'] as const)('authenticates and reports unavailable purchases in %s authority mode', async mode => {
    loadConfig({ NODE_ENV: 'test', DATA_AUTHORITY: mode, PLATFORM_API_URL: 'http://127.0.0.1:9000', AUTH_SECRET: 'issue53-only-fixture-secret' })
    const app = Fastify()
    const ctx = {} as AppContext
    app.decorateRequest('user', null)
    app.addHook('preHandler', async request => {
      if (request.headers.authorization === 'Bearer fixture-session') request.user = { id: 'fixture', email: 'fixture@example.test', role: 'user', status: 'active', sessionId: 'fixture-session' }
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.status).send({ message: error.message })
      throw error
    })
    installPlatformIntegration(app, ctx)
    await app.register(registerFrontendCompatRoutes, { ctx, prefix: '/api' })
    try {
      expect((await app.inject('/api/infrastructure/capabilities')).statusCode).toBe(401)
      const headers = { authorization: 'Bearer fixture-session' }
      const response = await app.inject({ url: '/api/infrastructure/capabilities', headers })
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
      for (const [service, path] of [['ips', '/ips'], ['trafficPackages', '/traffic-packages']] as const) {
        expect(response.json().data[service].enabled).toBe(false)
        const rejected = await app.inject({ method: 'POST', url: `/api${path}`, headers, payload: {} })
        expect(rejected.statusCode).toBe(400)
        expect(rejected.json().message).toBe(response.json().data[service].reason)
      }
    } finally { await app.close() }
  })
})
