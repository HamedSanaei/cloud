import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import type { AppContext } from '../../app.js'

export const registerHealthRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  // Liveness — the process is up. No dependencies checked.
  app.get('/health/live', async () => ({ status: 'ok' }))

  // Readiness — critical internal dependencies (PostgreSQL) must respond.
  app.get('/health/ready', async (_request, reply) => {
    try {
      await ctx.db.execute(sql`select 1`)
      return { status: 'ok', checks: { database: 'ok' } }
    } catch {
      return reply.status(503).send({ status: 'error', checks: { database: 'error' } })
    }
  })
}