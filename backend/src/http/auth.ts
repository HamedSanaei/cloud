import type { FastifyRequest } from 'fastify'
import type { SessionUser } from '../modules/auth/service.js'
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js'

export const AUTH_COOKIE = 'cloud_session'

export function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined
  const cookie = request.cookies?.[AUTH_COOKIE]
  return cookie || undefined
}

export function requireUser(request: FastifyRequest): SessionUser {
  const user = request.user
  if (!user) throw new UnauthorizedError('ابتدا وارد حساب خود شوید')
  return user
}

export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = requireUser(request)
  if (user.role !== 'admin') throw new ForbiddenError('این عملیات نیاز به دسترسی مدیر دارد')
  return user
}

/**
 * CSRF defense for cookie-authenticated state changes: same-site (SameSite=Lax)
 * cookies plus an Origin check. Browser-originated mutations must carry an
 * Origin that matches the request host or a configured CORS origin. Non-browser
 * clients (no Origin) are accepted — CSRF requires a browser.
 */
export function checkCsrfOrigin(request: FastifyRequest, allowedOrigins: string[]): void {
  const method = request.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const usedCookie = Boolean(request.cookies?.[AUTH_COOKIE])
  if (!usedCookie) return

  const origin = request.headers.origin
  if (!origin) return // non-browser client

  const host = request.headers.host
  if (host && origin === `http://${host}`) return
  if (host && origin === `https://${host}`) return
  if (allowedOrigins.includes(origin)) return
  throw new ForbiddenError('درخواست متقاطع رد شد (CSRF)')
}