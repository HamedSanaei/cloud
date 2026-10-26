import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import type { DbClient } from './db/index.js'
import type { CloudQueues } from './jobs/queue.js'
import type { Logger } from './logger.js'
import { getConfig, isProduction, redactSecrets } from './config.js'
import { AppError, ValidationError } from './lib/errors.js'
import { checkCsrfOrigin, extractToken, requireUser } from './http/auth.js'
import { authenticateToken } from './modules/auth/service.js'
import type { SessionUser } from './modules/auth/service.js'
import { AUTH_COOKIE } from './http/auth.js'
import { registerHealthRoutes } from './modules/health/routes.js'
import { registerAuthRoutes } from './modules/auth/routes.js'
import { installPlatformIntegration } from './modules/integration/platform.js'
import { registerUserRoutes } from './modules/users/routes.js'
import { registerWalletRoutes } from './modules/wallets/routes.js'
import { registerCatalogRoutes } from './modules/catalog/routes.js'
import { registerQuoteRoutes } from './modules/quotes/routes.js'
import { registerOrderRoutes } from './modules/orders/routes.js'
import { registerInvoiceRoutes } from './modules/invoices/routes.js'
import { registerSubscriptionRoutes } from './modules/subscriptions/routes.js'
import { registerServerRoutes } from './modules/servers/routes.js'
import { registerAdminRoutes } from './modules/admin/routes.js'
import { registerFrontendCompatRoutes } from './modules/frontend/routes.js'

export interface AppContext {
  db: DbClient
  queues: CloudQueues
  logger: Logger
  exposeDocs?: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | null
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const config = getConfig()
  const app = Fastify({
    loggerInstance: ctx.logger as unknown as FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    maxParamLength: 200,
    requestIdHeader: 'x-request-id',
    disableRequestLogging: isProduction(),
  })

  await app.register(sensible)
  await app.register(cookie)

  if (ctx.exposeDocs) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'پارس سرور API', version: '0.1.0', description: 'پارس سرور platform API (v1)' },
      },
    })
    await app.register(swaggerUi, { routePrefix: '/docs' })
  }

  await app.register(helmet, {
    contentSecurityPolicy: false, // API only — the SPA nginx handles its own headers
  })

  const corsOrigins = config.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (corsOrigins.length > 0) {
    await app.register(cors, { origin: corsOrigins, credentials: true })
  }

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limit', message: 'تعداد درخواست‌ها بیش از حد مجاز است' }),
  })

  // ---- auth resolution -----------------------------------------------------
  app.decorateRequest('user', null)
  app.addHook('preHandler', async (request, reply) => {
    const token = extractToken(request)
    if (token) {
      const user = await authenticateToken(ctx.db, token)
      if (user && 'needsRotation' in user && (user as { needsRotation: boolean }).needsRotation) {
        // Session older than the rotation window: require explicit refresh.
        request.user = null
        reply.header('X-Session-Rotation-Required', '1')
        return
      }
      request.user = user
    }
  })

  // ---- CSRF (Origin check) for cookie-authenticated mutations --------------
  app.addHook('preHandler', async (request) => {
    if (request.user && request.cookies?.[AUTH_COOKIE]) {
      checkCsrfOrigin(request, corsOrigins)
    }
  })

  // ---- error handling -------------------------------------------------------
  app.setErrorHandler((rawErr, request, reply) => {
    const err = rawErr as Error & { code?: string; statusCode?: number }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ statusCode: err.status, error: err.code, message: err.message, details: err.details })
    }
    if (err.code === '23505') {
      return reply.status(409).send({ statusCode: 409, error: 'conflict', message: 'رکورد تکراری است' })
    }
    if (err.code === '23503') {
      return reply.status(409).send({ statusCode: 409, error: 'conflict', message: 'رکورد مرتبط یافت نشد' })
    }
    if (rawErr instanceof SyntaxError && 'statusCode' in rawErr) {
      return reply.status(400).send({ statusCode: 400, error: 'bad_request', message: 'بدنه درخواست نامعتبر است' })
    }
    ctx.logger.error({ err: redactSecrets(err.message), stack: err.stack, path: request.url }, 'unhandled error')
    const status = err.statusCode ?? 500
    return reply.status(status).send({
      statusCode: status,
      error: status >= 500 ? 'internal_error' : 'error',
      message: status >= 500 ? 'خطای داخلی سرور' : err.message,
    })
  })

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.status(404).send({ statusCode: 404, error: 'not_found', message: 'مسیر API یافت نشد' })
    }
    return reply.status(404).send({ statusCode: 404, error: 'not_found', message: 'not found' })
  })

  // ---- routes ---------------------------------------------------------------
  installPlatformIntegration(app, ctx)
  const v1 = {
    prefix: '/api/v1',
    ctx,
  }
  await app.register(registerHealthRoutes, { prefix: '/api', ctx })
  await app.register(registerAuthRoutes, v1)
  await app.register(registerUserRoutes, v1)
  await app.register(registerWalletRoutes, v1)
  await app.register(registerCatalogRoutes, v1)
  await app.register(registerQuoteRoutes, v1)
  await app.register(registerOrderRoutes, v1)
  await app.register(registerInvoiceRoutes, v1)
  await app.register(registerSubscriptionRoutes, v1)
  await app.register(registerServerRoutes, v1)
  await app.register(registerAdminRoutes, v1)

  // Unversioned alias for the current SPA API layer (same handlers).
  const compat = { prefix: '/api', ctx }
  await app.register(registerAuthRoutes, compat)
  await app.register(registerUserRoutes, compat)
  await app.register(registerWalletRoutes, compat)
  await app.register(registerCatalogRoutes, compat)
  await app.register(registerQuoteRoutes, compat)
  await app.register(registerOrderRoutes, compat)
  await app.register(registerInvoiceRoutes, compat)
  await app.register(registerSubscriptionRoutes, compat)
  await app.register(registerServerRoutes, compat)
  await app.register(registerAdminRoutes, compat)
  await app.register(registerFrontendCompatRoutes, { prefix: '/api', ctx })

  return app
}

export { requireUser }

export function sessionCookieOptions(): { path: string; httpOnly: boolean; sameSite: 'lax'; secure: boolean; maxAge: number } {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: getConfig().COOKIE_SECURE,
    maxAge: 30 * 24 * 60 * 60,
  }
}

export { AUTH_COOKIE, ValidationError }
