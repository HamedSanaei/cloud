/**
 * Backend configuration — all values come from the environment.
 * Secrets (DATABASE_URL, REDIS_URL, AUTH_SECRET, LEASEWEB_API_KEY) are never
 * logged, never committed, and never exposed through any API endpoint.
 */
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().default('0.0.0.0'),
  // 0 = ephemeral port (useful for tests); production sets an explicit port.
  PORT: z.coerce.number().int().min(0).default(8000),

  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://cloud:cloud@127.0.0.1:5432/cloud'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  // Rotation secret used to derive cookie/session signing material.
  AUTH_SECRET: z.string().min(16).default('dev-only-auth-secret-change-me-please'),

  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  CORS_ORIGIN: z.string().default(''), // comma-separated list; empty = same-origin only

  // ---- Leaseweb ------------------------------------------------------------
  // Modes: mock (default, safe) | live. Real ordering additionally requires
  // LEASEWEB_ORDERING_ENABLED=true. Never enable automatically.
  LEASEWEB_MODE: z.enum(['mock', 'live']).default('mock'),
  LEASEWEB_API_BASE_URL: z.string().url().default('https://api.leaseweb.com'),
  LEASEWEB_API_KEY: z.string().default(''),
  LEASEWEB_ORDERING_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // ---- Business --------------------------------------------------------------
  DEFAULT_PROVIDER: z.string().default('leaseweb'),
  DEFAULT_SALES_CURRENCY: z.string().default('IRR'),

  // Quote lifetime (minutes).
  QUOTE_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  // Renewal job horizon (days ahead to look for due subscriptions).
  RENEWAL_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(3),
  // Grace period after a failed renewal (days).
  RENEWAL_GRACE_DAYS: z.coerce.number().int().positive().default(3),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }
  cached = parsed.data
  return cached
}

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig()
  return cached
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === 'production'
}

export function isTest(): boolean {
  return getConfig().NODE_ENV === 'test'
}

/** True when real Leaseweb ordering is allowed. Requires BOTH flags. */
export function leasewebOrderingEnabled(): boolean {
  const c = getConfig()
  return c.LEASEWEB_MODE === 'live' && c.LEASEWEB_ORDERING_ENABLED
}

export function redactSecrets(input: string): string {
  const c = getConfig()
  const secrets = [c.AUTH_SECRET, c.LEASEWEB_API_KEY].filter((s) => s.length >= 8)
  let out = input
  for (const s of secrets) out = out.split(s).join('***REDACTED***')
  return out
}