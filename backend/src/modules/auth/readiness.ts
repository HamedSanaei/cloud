/** Deployment-only validation. Never print credential values in errors. */
import { getConfig, type AppConfig } from '../../config.js'

export function assertAuthenticationReady(config: AppConfig = getConfig()): void {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM',
    'PARSGREEN_SIGNATURE', 'PARSGREEN_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
    .filter(name => !String(config[name as keyof AppConfig] ?? '').trim())
  if (missing.length) throw new Error(`Missing live authentication configuration: ${missing.join(', ')}`)
  if (config.SMTP_FROM.includes('example.com')) throw new Error('SMTP_FROM must not use the placeholder sender')
  if (config.AUTH_DELIVERY_MODE !== 'live') throw new Error('AUTH_DELIVERY_MODE must be live')
  const origin = new URL(config.FRONTEND_URL)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('FRONTEND_URL must be an HTTPS origin')
  }
  if (config.GOOGLE_REDIRECT_URI !== `${origin.origin}/api/v1/auth/google/callback`) {
    throw new Error('GOOGLE_REDIRECT_URI must match the public website callback')
  }
  if (!config.COOKIE_SECURE || config.AUTH_SECRET.length < 32 || config.AUTH_SECRET.startsWith('dev-only-')) {
    throw new Error('Persistent production AUTH_SECRET and secure cookies are required')
  }
}
