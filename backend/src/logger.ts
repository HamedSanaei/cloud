import { pino } from 'pino'
import { getConfig } from './config.js'
import { recordEvent } from './modules/system/events.js'

/**
 * Structured logger. Only development uses the optional pretty-printer.
 * Tests and deployed images emit JSON without requiring dev dependencies.
 * Secrets are redacted below and explicitly by the config module.
 */
export function createLogger(name = 'cloud-server') {
  const config = getConfig()
  return pino({
    name,
    level: config.LOG_LEVEL,
    base: { env: config.NODE_ENV },
    serializers: { req(request) { return { id: request.id, method: request.method, url: typeof request.url === 'string' ? request.url.split('?')[0] : undefined } } },
    hooks: { logMethod(args, method, level) {
      const event = args[0]
      if (event && typeof event === 'object' && 'event' in event && typeof event.event === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(event.event)) {
        recordEvent(event.event, level >= 50 ? 'error' : level >= 40 ? 'warn' : 'info', name, event)
      }
      method.apply(this, args)
    } },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-lsw-auth"]',
        'req.headers.authorize',
        'req.headers.http_authorize',
        'req.headers["x-system-proof"]',
        '*.merchant', '*.encrypted', '*.proof', '*.secret', '*.code', '*.recoveryCodes', '*.STORE_SECRET_KEY', '*.SYSTEM_BACKUP_KEY',
        '*.TABAPAY_MERCHANT',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.tokenHash',
        '*.apiKey',
        '*.LEASEWEB_API_KEY',
      ],
      censor: '***REDACTED***',
    },
    transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } : undefined,
  })
}

export type Logger = ReturnType<typeof createLogger>
