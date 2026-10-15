/**
 * Backend infrastructure/auth stays environment-owned; provider/storefront
 * settings may additionally come from the runtime TOML configuration.
 * Credentials must never be logged or exposed through API endpoints.
 */
import { z } from 'zod'
import { loadLocalEnvFiles } from './lib/env-loader.js'
import { loadProviderConfig, type ProviderRuntimeConfig } from './lib/provider-config.js'
export type { ProviderAccount, HetznerConfig, LeasewebConfig, AsiatechConfig } from './lib/provider-config.js'

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

  // New retail quotes are refused when the provider catalog is older than
  // this (stale provider price data must never be sold). 0 disables the check.
  CATALOG_MAX_AGE_MINUTES: z.coerce.number().int().min(0).default(1440),

  // Renewal job horizon (days ahead to look for due subscriptions).
  RENEWAL_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(3),
  // Grace period after a failed renewal (days).
  RENEWAL_GRACE_DAYS: z.coerce.number().int().positive().default(3),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

export type AppConfig = z.infer<typeof envSchema> & ProviderRuntimeConfig

let cached: AppConfig | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Centralized local env loading (backend/.env.local then backend/.env).
  // Runs before any config value is read; explicit process env wins; skipped
  // in production. Every entrypoint (API, worker, migrate, seed, CLI) funnels
  // through loadConfig(), so this is the only place files are read.
  if (env === process.env) loadLocalEnvFiles()

  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }
  cached = { ...parsed.data, ...loadProviderConfig(env, env === process.env) }
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

/** TOML accounts are authoritative when configured. */
export function leasewebOrderingEnabled(): boolean {
  const c = getConfig()
  return c.PROVIDERS.leaseweb.enabled && c.PROVIDERS.leaseweb.orderingEnabled
}

export function redactSecrets(input: string): string {
  const c = getConfig()
  const secrets = [
    c.AUTH_SECRET, c.DATABASE_URL, c.REDIS_URL, c.LEASEWEB_API_KEY,
    c.PROVIDERS.asiatech.apiKey,
    ...Object.values(c.PROVIDERS).flatMap((provider) =>
      'accounts' in provider ? provider.accounts.flatMap((account) => [account.apiKey ?? '', account.apiToken ?? '']) : []),
  ].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length)
  let out = input
  for (const s of secrets) out = out.split(s).join('***REDACTED***')
  return out
}