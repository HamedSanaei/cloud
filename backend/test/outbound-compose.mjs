// Parse both deployment sources without a daemon, real secrets or running services.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = mkdtempSync(path.join(tmpdir(), 'parserver-compose-')), envFile = path.join(directory, 'empty.env')
writeFileSync(envFile, '')
const env = { ...process.env, IMAGE_SHA: 'ghcr.io/example/cloud:fixture', API_IMAGE_SHA: 'ghcr.io/example/cloud-api:fixture',
  POSTGRES_PASSWORD: 'fixture-only', DATABASE_URL: 'postgres://fixture:fixture@cloud-postgres/fixture', REDIS_URL: 'redis://cloud-redis:6379',
  FRONTEND_URL: 'https://example.test', AUTH_SECRET: 'fixture-only-auth-secret-123456', SMTP_HOST: 'smtp.example.test', SMTP_PASSWORD: 'fixture-only', SMTP_FROM: 'fixture@example.test',
  PARSGREEN_SIGNATURE: 'fixture-only', PARSGREEN_FROM: 'fixture-only', GOOGLE_CLIENT_ID: 'fixture-only', GOOGLE_CLIENT_SECRET: 'fixture-only', GOOGLE_REDIRECT_URI: 'https://example.test/callback',
  STORE_SECRET_KEY: 'a'.repeat(64), OUTBOUND_PROXY_SUPER_ADMIN_IDS: '00000000-0000-4000-8000-000000000046' }
try {
  for (const file of ['docker-compose.yml', 'docker-compose.site.yml']) {
    const data = JSON.parse(execFileSync('docker', ['compose', '--env-file', envFile, '-f', file, 'config', '--format', 'json'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    assert.equal(data.services['cloud-api'].environment.STORE_SECRET_KEY, env.STORE_SECRET_KEY, 'API encryption key missing')
    assert.equal(data.services['cloud-worker'].environment.STORE_SECRET_KEY, env.STORE_SECRET_KEY, 'Worker encryption key missing')
    assert.equal(data.services['cloud-api'].environment.OUTBOUND_PROXY_SUPER_ADMIN_IDS, env.OUTBOUND_PROXY_SUPER_ADMIN_IDS, 'Explicit admin allowlist missing')
    console.log(`${file}: valid; API/worker key and explicit allowlist passed`)
  }
} finally { unlinkSync(envFile); rmdirSync(directory) }
