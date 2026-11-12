import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getConfig } from '../../src/config.js'
import { createSession, registerUser } from '../../src/modules/auth/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'

describe.skipIf(!dbAvailable || getConfig().DATA_AUTHORITY !== 'site')('canonical site inventory (integration)', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    const user = await registerUser(ctx.db, {
      email: 'site-only@test.local',
      password: 'TestPassword123!',
    })
    token = (await createSession(ctx.db, user.id, {})).token
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await ctx?.close()
  })

  it('reports that Telegram integration is disabled', async () => {
    const response = await app.inject({
      url: '/api/integration/status',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data.enabled).toBe(false)
  })

  it('gets empty site-owned server inventory without any Telegram link', async () => {
    const response = await app.inject({
      url: '/api/servers',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([])
  })

  it('rejects unauthenticated server inventory reads', async () => {
    const response = await app.inject('/api/servers')
    expect(response.statusCode).toBe(401)
  })
})
