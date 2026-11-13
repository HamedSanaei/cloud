// Isolated real-tool integration, NOT production. Removes only its own labeled
// containers/network. Never restarts a Docker daemon or existing services.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const id = 'system-recovery-' + randomUUID(), image = process.env.SYSTEM_SMOKE_IMAGE || 'tofan-cloud-api:ci'
const wsl = process.env.SYSTEM_SMOKE_DOCKER_WSL === '1', command = wsl ? 'wsl.exe' : 'docker', prefix = wsl ? ['-d', 'Ubuntu', '--', 'docker'] : []
function docker(args, input, allowFailure = false) {
  const r = spawnSync(command, [...prefix, ...args], { input, encoding: 'utf8', timeout: 240000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  if (!allowFailure && r.status !== 0) throw new Error((r.stdout || '') + (r.stderr || '') + (r.error?.message || ''))
  return r
}
try {
  docker(['network', 'create', '--label', 'parserver.test=system-recovery', '--label', `parserver.run=${id}`, id])
  docker(['run', '-d', '--name', id + '-pg', '--label', `parserver.run=${id}`, '--network', id, '--network-alias', 'postgres', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture-isolated-only', '-e', 'POSTGRES_DB=fixture', 'postgres:17-alpine'])
  docker(['run', '-d', '--name', id + '-redis', '--label', `parserver.run=${id}`, '--network', id, '--network-alias', 'redis', 'redis:7-alpine'])
  let ready = false
  for (let i = 0; i < 60; i++) { if (docker(['exec', id + '-pg', 'pg_isready', '-U', 'fixture'], undefined, true).status === 0) { ready = true; break } await delay(500) }
  if (!ready) throw new Error('Isolated PostgreSQL failed readiness')
  const env = {
    NODE_ENV: 'test', APP_ENV: 'test', AUTH_SECRET: 'fixture-system-smoke-secret-only', AUTH_DELIVERY_MODE: 'log', DATA_AUTHORITY: 'site', PLATFORM_API_URL: '',
    DATABASE_URL: 'postgres://fixture:fixture-isolated-only@postgres:5432/fixture', REDIS_URL: 'redis://redis:6379',
    LEASEWEB_MODE: 'mock', LEASEWEB_ENABLED: 'false', LEASEWEB_ORDERING_ENABLED: 'false', HETZNER_ENABLED: 'false', TABAPAY_ENABLED: 'false',
    STORE_SECRET_KEY: '1'.repeat(64), SYSTEM_BACKUP_KEY: '2'.repeat(64), SYSTEM_INSTANCE_ID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', SYSTEM_BACKUP_ENABLED: 'true', SYSTEM_RESTORE_ENABLED: 'true', LOG_LEVEL: 'error',
  }
  const result = docker(['run', '--rm', '-i', '--name', id + '-api', '--label', `parserver.run=${id}`, '--network', id,
    '--shm-size=1g', '--tmpfs', '/var/lib/parserver/system:uid=10001,gid=10001,mode=700', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), image, 'node', '--input-type=module'], readFileSync(new URL('./system-recovery-scenario.mjs', import.meta.url), 'utf8'))
  console.log(result.stdout)
} finally {
  for (const suffix of ['-api', '-pg', '-redis']) {
    const owner = docker(['inspect', '--format', '{{index .Config.Labels "parserver.run"}}', id + suffix], undefined, true)
    if (owner.status === 0 && owner.stdout.trim() === id) docker(['rm', '-f', '-v', id + suffix], undefined, true)
  }
  const owner = docker(['network', 'inspect', '--format', '{{index .Labels "parserver.run"}}', id], undefined, true)
  if (owner.status === 0 && owner.stdout.trim() === id) docker(['network', 'rm', id], undefined, true)
}
