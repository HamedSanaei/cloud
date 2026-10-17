import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { assertAuthenticationReady } from '../../src/modules/auth/readiness.js'

const fixture = {
  NODE_ENV: 'test', PLATFORM_API_URL: 'http://127.0.0.1:8000',
  AUTH_SECRET: 'fixture-only-long-persistent-session-key', COOKIE_SECURE: 'true',
  AUTH_DELIVERY_MODE: 'live', FRONTEND_URL: 'https://console.example.test',
  SMTP_HOST: 'smtp.example.test', SMTP_USER: 'fixture-user', SMTP_PASSWORD: 'fixture-not-a-secret',
  SMTP_FROM: 'fixture@example.test', PARSGREEN_SIGNATURE: 'fixture-not-a-secret', PARSGREEN_FROM: 'fixture-line',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-not-a-secret',
  GOOGLE_REDIRECT_URI: 'https://console.example.test/api/v1/auth/google/callback',
}

describe('live deployment authentication preflight', () => {
  it('names missing configuration without exposing populated secrets', () => {
    const config = loadConfig({ ...fixture, SMTP_HOST: '', GOOGLE_CLIENT_ID: '' })
    expect(() => assertAuthenticationReady(config)).toThrow('SMTP_HOST, GOOGLE_CLIENT_ID')
    try { assertAuthenticationReady(config) } catch (error) { expect(String(error)).not.toContain('fixture-not-a-secret') }
  })
  it('refuses log delivery, incorrect callback, weak session keys and insecure cookies', () => {
    for (const overrides of [{ AUTH_DELIVERY_MODE: 'log' }, { GOOGLE_REDIRECT_URI: 'https://other.example.test/callback' },
      { COOKIE_SECURE: 'false' }, { AUTH_SECRET: 'fixture-too-short' }]) {
      expect(() => assertAuthenticationReady(loadConfig({ ...fixture, ...overrides }))).toThrow()
    }
  })
  it('accepts explicit production settings without sending email/SMS or making OAuth requests', () => {
    expect(() => assertAuthenticationReady(loadConfig(fixture))).not.toThrow()
  })
})
