import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { assertPlatformCompatibility, platformEnabled } from '../integration/platform.js'
import { assertAuthenticationReady } from '../auth/readiness.js'
import { isProduction } from '../../config.js'

export const registerHealthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  // Liveness — the process is up. No dependencies checked.
  app.get('/health/live', async () => ({ status: 'ok' }))

  // Unified readiness also requires the canonical service's financial contract.
  app.get('/health/ready', async (_request, reply) => {
    try {
      await ctx.db.execute(sql`select 1`)
    } catch {
      return reply.status(503).send({ status: 'error', checks: { database: 'error' } })
    }
    if (isProduction() && platformEnabled()) {
      try { assertAuthenticationReady() } catch {
        return reply.status(503).send({ status: 'error', checks: { database: 'ok', authentication: 'error' } })
      }
    }
    try {
      await assertPlatformCompatibility()
      return { status: 'ok', checks: { database: 'ok', ...(platformEnabled() ? { platform: 'ok' } : {}) } }
    } catch {
      return reply.status(503).send({ status: 'error', checks: { database: 'ok', platform: 'error' } })
    }
  })
}
