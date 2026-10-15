import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, redactSecrets } from '../../src/config.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function configuration(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'servercloud-config-'))
  directories.push(directory)
  const path = join(directory, 'configuration.toml')
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}
const providerToml = `
[database]
url = "must-not-replace-this-repository-infrastructure"
[providers.hetzner]
enabled = true
api_token = "ignored-legacy-token"
[[providers.hetzner.accounts]]
id = "primary"
api_token = "fake-test-primary-credential"
priority = 200
[[providers.hetzner.accounts]]
id = "secondary"
api_token = "fake-test-secondary-credential"
priority = 100
enabled = false
[providers.leaseweb]
enabled = true
locations = ["FRA-01", "AMS-01"]
[providers.leaseweb.accounts.sales]
api_key = "fake-test-leaseweb-credential"
priority = 10
[storefront.catalog_sync]
enabled = false
interval_seconds = 1200
[storefront.pricing.hetzner]
mode = "markup"
markup_percent = 25
auto_publish = true
[storefront.pricing."leaseweb.hourly"]
markup_percent = 18
`

describe('provider runtime configuration', () => {
  it('never reads a real file when tests pass an explicit environment', () => {
    const config = loadConfig({ NODE_ENV: 'test' })
    expect(config.PROVIDERS.hetzner.enabled).toBe(false)
    expect(config.PROVIDERS.hetzner.accounts).toEqual([])
    expect(config.PROVIDERS.leaseweb.accounts).toEqual([])
    expect(config.STOREFRONT_PRICING).toEqual({})
  })

  it('reads only provider/storefront TOML and preserves environment infrastructure', () => {
    const config = loadConfig({ NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: configuration(providerToml), DATABASE_URL: 'postgres://explicit-infrastructure' })
    expect(config.DATABASE_URL).toBe('postgres://explicit-infrastructure')
    expect(config.PROVIDERS.hetzner.accounts.find((account) => account.id === 'primary')?.apiToken).toBe('fake-test-primary-credential')
    expect(config.PROVIDERS.hetzner.orderingEnabled).toBe(false)
    expect(config.PROVIDERS.leaseweb.locations).toEqual(['FRA-01', 'AMS-01'])
    expect(config.CATALOG_SYNC_ENABLED).toBe(false)
    expect(config.CATALOG_SYNC_INTERVAL_SECONDS).toBe(1200)
    expect(config.STOREFRONT_PRICING.hetzner).toEqual({ markupPercent: 25, autoPublish: true })
    expect(config.STOREFRONT_PRICING['leaseweb.hourly']).toEqual({ markupPercent: 18, autoPublish: false })
    const redacted = redactSecrets('fake-test-primary-credential fake-test-secondary-credential fake-test-leaseweb-credential')
    expect(redacted).toBe('***REDACTED*** ***REDACTED*** ***REDACTED***')
  })

  it('lets explicitly supplied environment settings override matching TOML fields', () => {
    const config = loadConfig({
      NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: configuration(providerToml),
      HETZNER_ENABLED: 'false', HETZNER_ORDERING_ENABLED: 'true',
      HETZNER_API_BASE_URL: 'https://hetzner.example/v1',
      HETZNER_ACCOUNTS: JSON.stringify([{ id: 'default', api_token: 'fake-test-replacement', priority: 1 }]),
      LEASEWEB_LOCATIONS: 'LON-01', CATALOG_SYNC_ENABLED: 'true', CATALOG_SYNC_INTERVAL_SECONDS: '60',
    })
    expect(config.PROVIDERS.hetzner.enabled).toBe(false)
    expect(config.PROVIDERS.hetzner.orderingEnabled).toBe(true)
    expect(config.PROVIDERS.hetzner.baseUrl).toBe('https://hetzner.example/v1')
    expect(config.PROVIDERS.hetzner.accounts).toHaveLength(1)
    expect(config.PROVIDERS.hetzner.accounts[0]?.apiToken).toBe('fake-test-replacement')
    expect(config.PROVIDERS.leaseweb.locations).toEqual(['LON-01'])
    expect(config.CATALOG_SYNC_ENABLED).toBe(true)
    expect(config.CATALOG_SYNC_INTERVAL_SECONDS).toBe(60)
  })

  it('overrides a primary account credential before active credential validation', () => {
    const file = configuration('[providers.hetzner]\nenabled=true\n[[providers.hetzner.accounts]]\nid="default"\napi_token=""')
    const config = loadConfig({ NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: file, HETZNER_API_TOKEN: 'fake-test-env-credential' })
    expect(config.PROVIDERS.hetzner.accounts[0]?.apiToken).toBe('fake-test-env-credential')
  })

  it('does not erase configured account credentials with empty optional environment values', () => {
    const config = loadConfig({ NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: configuration(providerToml), LEASEWEB_API_KEY: '', HETZNER_API_TOKEN: '' })
    expect(config.PROVIDERS.leaseweb.accounts[0]?.apiKey).toBe('fake-test-leaseweb-credential')
    expect(config.PROVIDERS.hetzner.accounts.find((account) => account.id === 'primary')?.apiToken).toBe('fake-test-primary-credential')
  })

  it('rejects duplicate IDs, missing active credentials and enabled unsupported providers', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', HETZNER_ACCOUNTS: '[{"id":"same","api_token":"fake-test-a"},{"id":"same","api_token":"fake-test-b"}]' })).toThrow(/duplicate or invalid id/)
    expect(() => loadConfig({ NODE_ENV: 'test', HETZNER_ACCOUNTS: '[{"id":"active"}]' })).toThrow(/credential required/)
    expect(() => loadConfig({ NODE_ENV: 'test', ASIATECH_ENABLED: 'true' })).toThrow(/implementation is unavailable/)
  })

  it('retains disabled account ownership even when no route accepts new provisioning', () => {
    const config = loadConfig({ NODE_ENV: 'test', HETZNER_ENABLED: 'true', HETZNER_ACCOUNTS: '[{"id":"old","enabled":false,"api_token":"fake-test-old"}]' })
    expect(config.PROVIDERS.hetzner.accounts[0]?.enabled).toBe(false)
    expect(config.PROVIDERS.hetzner.accounts[0]?.id).toBe('old')
  })

  it('never includes TOML source or credential values in parse errors', () => {
    const file = configuration('[providers.hetzner]\napi_token = "fake-test-parse-sensitive" broken')
    expect(() => loadConfig({ NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: file })).toThrow('Unable to read provider TOML configuration')
    try { loadConfig({ NODE_ENV: 'test', CLOUD_PLATFORM_CONFIG_FILE: file }) } catch (error) {
      expect(String(error)).not.toContain('fake-test-parse-sensitive')
    }
  })
})
