import nodemailer from 'nodemailer'
import type { Socket } from 'node:net'
import { getConfig, isProduction } from '../../config.js'

export function smtpTransport(config: ReturnType<typeof getConfig>, connection?: Socket, authenticate = true) {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE && (!!connection || isProduction()),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    ...(connection ? { connection, tls: { servername: config.SMTP_HOST, rejectUnauthorized: true } } : {}),
    auth: authenticate && config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  })
}
