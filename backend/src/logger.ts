import { pino } from 'pino'
import { getConfig } from './config.js'

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
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-lsw-auth"]',
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