import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

export interface ProviderAccount {
  id: string
  enabled: boolean
  priority: number
  state: string
  label: string
  apiToken?: string
  apiKey?: string
}
export interface HetznerConfig {
  enabled: boolean
  displayName: string
  baseUrl: string
  orderingEnabled: boolean
  accounts: ProviderAccount[]
}
export interface LeasewebConfig extends HetznerConfig {
  locations: string[]
  families: { vps: { enabled: boolean }; cloud: { enabled: boolean } }
}
export interface AsiatechConfig {
  enabled: boolean
  displayName: string
  baseUrl: string
  apiKey: string
}
export interface ProviderRuntimeConfig {
  PROVIDERS: { hetzner: HetznerConfig; leaseweb: LeasewebConfig; asiatech: AsiatechConfig }
  CATALOG_SYNC_ENABLED: boolean
  CATALOG_SYNC_INTERVAL_SECONDS: number
  STOREFRONT_PRICING: Record<string, { markupPercent: number; autoPublish: boolean }>
}

type Table = Record<string, unknown>
const table = (value: unknown): Table => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Table : {}
function invalid(field: string): never { throw new Error(`Invalid provider configuration: ${field}`) }
function text(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') return invalid(field)
  return value.trim()
}
function bool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return invalid(field)
}
function integer(value: unknown, fallback: number, field: string, min = 0): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min) return invalid(field)
  return parsed
}
function url(value: unknown, fallback: string, field: string): string {
  const result = text(value, fallback, field)
  try {
    const parsed = new URL(result)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return invalid(field)
    return result.replace(/\/+$/, '')
  } catch { return invalid(field) }
}
function credential(value: unknown, field: string): string {
  const result = text(value, '', field)
  if (result && (/\s/.test(result) || /^(change[_-]?me|placeholder|your[_-])/i.test(result))) return invalid(field)
  return result
}
function accounts(value: unknown, provider: string, legacy: unknown, override?: string): ProviderAccount[] {
  let rows: Array<[string | undefined, unknown]>
  if (value === undefined) {
    rows = legacy ? [['default', { [provider === 'hetzner' ? 'api_token' : 'api_key']: legacy }]] : []
  } else if (Array.isArray(value)) {
    rows = value.map((row) => [undefined, row])
  } else if (value !== null && typeof value === 'object') {
    rows = Object.entries(value)
  } else return invalid(`${provider}.accounts`)
  const ids = new Set<string>()
  const primaryId = rows.some(([key, item]) => (table(item).id ?? key) === 'default') ? 'default' : text(table(rows[0]?.[1]).id, rows[0]?.[0] ?? '', `${provider}.account.id`).toLowerCase()
  return rows.map(([key, raw]) => {
    const row = table(raw)
    const id = text(row.id, key ?? '', `${provider}.account.id`).toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(id) || ids.has(id)) return invalid(`${provider}.accounts duplicate or invalid id`)
    ids.add(id)
    const enabled = bool(row.enabled, true, `${provider}.account.enabled`)
    const state = text(row.state, 'active', `${provider}.account.state`).toLowerCase()
    if (!['active', 'draining', 'disabled', 'exhausted'].includes(state)) return invalid(`${provider}.account.state`)
    const secretField = provider === 'hetzner' ? 'api_token' : 'api_key'
    const secret = credential(override !== undefined && id === primaryId ? override : row[secretField] ?? row[provider === 'hetzner' ? 'apiToken' : 'apiKey'], `${provider}.account credential`)
    if (enabled && state !== 'disabled' && !secret) return invalid(`${provider}.active account credential required`)
    return {
      id, enabled, state,
      priority: integer(row.priority, 100, `${provider}.account.priority`),
      label: text(row.label, id, `${provider}.account.label`),
      ...(provider === 'hetzner' ? { apiToken: secret } : { apiKey: secret }),
    }
  })
}
function envJson(value: string | undefined, field: string): unknown {
  if (value === undefined) return undefined
  try { return JSON.parse(value) as unknown } catch { return invalid(field) }
}

/** Only providers/storefront are read; infrastructure/auth always stay env-owned. */
export function loadProviderConfig(env: NodeJS.ProcessEnv, useDefaultFile: boolean): ProviderRuntimeConfig {
  let document: Table = {}
  const explicit = env.CLOUD_PLATFORM_CONFIG_FILE
  const path = explicit || (env.NODE_ENV === 'production'
    ? '/etc/tofan-cloud/configuration.toml'
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../configuration.toml'))
  if (explicit || (useDefaultFile && env.NODE_ENV !== 'test')) {
    if (existsSync(path)) {
      try { document = table(parse(readFileSync(path, 'utf8'))) } catch {
        // Parser/read errors can embed the source line or credentials. Never forward them.
        throw new Error('Unable to read provider TOML configuration')
      }
    } else if (explicit || env.NODE_ENV === 'production') {
      throw new Error('Provider TOML configuration file is missing')
    }
  }
  const providers = table(document.providers)
  function provider(name: 'hetzner' | 'leaseweb'): HetznerConfig {
    const source = table(providers[name])
    const prefix = name.toUpperCase()
    const envSecret = env[`${prefix}_${name === 'hetzner' ? 'API_TOKEN' : 'API_KEY'}`]?.trim() || undefined
    const legacy = source[name === 'hetzner' ? 'api_token' : 'api_key']
    const accountRows = envJson(env[`${prefix}_ACCOUNTS`], `${name}.accounts`) ?? source.accounts
    const pool = accounts(accountRows, name, envSecret ?? legacy, envSecret)
    const enabled = bool(env[`${prefix}_ENABLED`] ?? source.enabled, name === 'leaseweb' && env.LEASEWEB_MODE === 'live', `${name}.enabled`)
    if (enabled && !pool.length) return invalid(`${name}.enabled provider requires configured accounts`)
    return {
      enabled,
      displayName: text(env[`${prefix}_DISPLAY_NAME`] ?? source.display_name, name === 'hetzner' ? 'Hetzner' : 'Leaseweb', `${name}.display_name`),
      baseUrl: url(env[`${prefix}_API_BASE_URL`] ?? source.base_url, name === 'hetzner' ? 'https://api.hetzner.cloud/v1' : 'https://api.leaseweb.com', `${name}.base_url`),
      orderingEnabled: bool(env[`${prefix}_ORDERING_ENABLED`] ?? source.ordering_enabled, false, `${name}.ordering_enabled`),
      accounts: pool,
    }
  }
  const lsw = table(providers.leaseweb)
  const families = table(lsw.families)
  const rawLocations = env.LEASEWEB_LOCATIONS !== undefined ? env.LEASEWEB_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean) : lsw.locations ?? []
  if (!Array.isArray(rawLocations) || rawLocations.some((item) => typeof item !== 'string' || !item.trim())) return invalid('leaseweb.locations')
  const asia = table(providers.asiatech)
  const asiaEnabled = bool(env.ASIATECH_ENABLED ?? asia.enabled, false, 'asiatech.enabled')
  if (asiaEnabled) return invalid('asiatech implementation is unavailable; disable this provider')
  const sync = table(table(document.storefront).catalog_sync)
  const pricing: ProviderRuntimeConfig['STOREFRONT_PRICING'] = {}
  const rawPricing = envJson(env.STOREFRONT_PRICING, 'storefront.pricing') ?? table(document.storefront).pricing
  for (const [name, value] of Object.entries(table(rawPricing))) {
    const row = table(value)
    const markup = row.markupPercent ?? row.markup_percent ?? 0
    if (typeof markup !== 'number' || !Number.isFinite(markup) || markup < 0) return invalid('storefront.pricing.markup_percent')
    if (row.mode !== undefined && row.mode !== 'markup') return invalid('storefront.pricing.mode')
    pricing[name] = { markupPercent: markup, autoPublish: bool(row.autoPublish ?? row.auto_publish, false, 'storefront.pricing.auto_publish') }
  }
  return {
    PROVIDERS: {
      hetzner: provider('hetzner'),
      leaseweb: {
        ...provider('leaseweb'), locations: rawLocations as string[],
        families: {
          vps: { enabled: bool(env.LEASEWEB_VPS_ENABLED ?? table(families.vps).enabled, true, 'leaseweb.families.vps.enabled') },
          cloud: { enabled: bool(env.LEASEWEB_CLOUD_ENABLED ?? table(families.cloud).enabled, true, 'leaseweb.families.cloud.enabled') },
        },
      },
      asiatech: {
        enabled: asiaEnabled,
        displayName: text(env.ASIATECH_DISPLAY_NAME ?? asia.display_name, 'Asiatech', 'asiatech.display_name'),
        baseUrl: text(env.ASIATECH_API_BASE_URL ?? asia.base_url, '', 'asiatech.base_url'),
        apiKey: text(env.ASIATECH_API_KEY ?? asia.api_key, '', 'asiatech.api_key'),
      },
    },
    CATALOG_SYNC_ENABLED: bool(env.CATALOG_SYNC_ENABLED ?? sync.enabled, true, 'storefront.catalog_sync.enabled'),
    CATALOG_SYNC_INTERVAL_SECONDS: integer(env.CATALOG_SYNC_INTERVAL_SECONDS ?? sync.interval_seconds, 900, 'storefront.catalog_sync.interval_seconds', 1),
    STOREFRONT_PRICING: pricing,
  }
}
