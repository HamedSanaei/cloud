import { pino } from 'pino'
import { getConfig, isProduction } from './config.js'

/**
 * Structured logger. In development we pretty-print; in production we emit
 * plain JSON lines. Secrets are redacted from any logged message via the
 * redact paths below plus explicit redaction in the config module.
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
    transport: isProduction() ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  })
}

export type Logger = ReturnType<typeof createLogger>