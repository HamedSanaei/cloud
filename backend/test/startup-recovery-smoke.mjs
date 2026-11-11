// Run from any directory with Node 24, installed backend dependencies and local Docker:
// node backend/test/startup-recovery-smoke.mjs --integration
// Uses only uniquely named disposable containers and random loopback ports. Never Compose.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const suffix = `${process.pid}-${Date.now()}`
const postgres = `cloud-startup-smoke-pg-${suffix}`
const redis = `cloud-startup-smoke-redis-${suffix}`
const created = []
let api
let phase = 'setup'
let exitCode
const events = []
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}
async function waitFor(condition, description, timeout = 150_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`API exited (${exitCode}) before ${description}`)
    if (await condition()) return
    // Real time is intentional: this smoke drives actual child processes and Docker.
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function assertNotServing(base) {
  try {
    await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(500) })
  } catch { return }
  throw new Error('API listened before startup dependencies were ready')
}

try {
  const [pgPort, redisPort, apiPort] = await Promise.all([freePort(), freePort(), freePort()])
  phase = 'creating disposable PostgreSQL and Redis'
  docker('create', '--name', postgres, '-e', 'POSTGRES_USER=cloud', '-e', 'POSTGRES_PASSWORD=smoke-only-password', '-e', 'POSTGRES_DB=cloud', '-p', `127.0.0.1:${pgPort}:5432`, process.env.SMOKE_POSTGRES_IMAGE || 'postgres:17-alpine')
  created.push(postgres)
  docker('create', '--name', redis, '-p', `127.0.0.1:${redisPort}:6379`, process.env.SMOKE_REDIS_IMAGE || 'redis:7-alpine')
  created.push(redis)
  const env = {
    ...process.env, NODE_ENV: 'test', APP_ENV: 'test', HOST: '127.0.0.1', PORT: String(apiPort),
    DATABASE_URL: `postgres://cloud:smoke-only-password@127.0.0.1:${pgPort}/cloud`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, PLATFORM_API_URL: '', CLOUD_PLATFORM_CONFIG_FILE: '',
    AUTH_SECRET: 'disposable-smoke-only-auth-secret', AUTH_DELIVERY_MODE: 'log', LOG_LEVEL: 'info',
    LEASEWEB_MODE: 'mock', LEASEWEB_ENABLED: 'false', HETZNER_ENABLED: 'false', ASIATECH_ENABLED: 'false',
    LEASEWEB_ACCOUNTS: '[]', HETZNER_ACCOUNTS: '[]', CATALOG_SYNC_ENABLED: 'false',
  }
  phase = 'starting real API while PostgreSQL and Redis are stopped'
  api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: backend, env, stdio: ['ignore', 'pipe', 'pipe'] })
  api.once('exit', (code, signal) => { exitCode = code ?? signal ?? 'unknown' })
  let buffered = ''
  api.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    let newline
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      try { events.push(JSON.parse(line)) } catch { /* Only structured startup events are evidence. */ }
    }
  })
  api.stderr.resume()
  const base = `http://127.0.0.1:${apiPort}`
  await waitFor(() => events.some((event) => event.event === 'startup_retry' && event.stage === 'postgres'), 'initial PostgreSQL startup retry', 30_000)
  await assertNotServing(base)
  phase = 'recovering PostgreSQL without restarting API'
  docker('start', postgres)
  await waitFor(() => events.some((event) => event.event === 'startup_retry' && event.stage === 'redis'), 'Redis startup retry')
  await assertNotServing(base)
  phase = 'recovering Redis without restarting API'
  docker('start', redis)
  let health
  await waitFor(async () => {
    try {
      const response = await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(2_000) })
      health = await response.json()
      return response.ok && health.status === 'ok' && health.checks.database === 'ok'
    } catch { return false }
  }, 'healthy real API')
  if (!events.some((event) => event.event === 'startup_ready' && event.stage === 'postgres' && event.attempt > 1)) throw new Error('Missing PostgreSQL recovery evidence')
  if (!events.some((event) => event.event === 'startup_ready' && event.stage === 'redis' && event.attempt > 1)) throw new Error('Missing Redis recovery evidence')
  if (process.argv.includes('--integration')) {
    phase = 'running PostgreSQL advisory-lock integration regression'
    const test = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/integration/migration-serialization.test.ts'], { cwd: backend, env, stdio: 'inherit' })
    const [code] = await once(test, 'exit')
    if (code !== 0) throw new Error(`Migration serialization integration exited ${code}`)
  }
  console.log(JSON.stringify({ smoke: 'passed', apiPid: api.pid, recoveredWithoutRestart: true, postgresRetries: events.filter((event) => event.event === 'startup_retry' && event.stage === 'postgres').length, redisRetries: events.filter((event) => event.event === 'startup_retry' && event.stage === 'redis').length, health }))
} catch (error) {
  console.error(`Recovery smoke failed during ${phase}: ${error.message}`)
  process.exitCode = 1
} finally {
  if (api && exitCode === undefined) {
    const stopped = once(api, 'exit')
    api.kill('SIGTERM')
    const timer = setTimeout(() => api.kill('SIGKILL'), 5_000)
    await stopped
    clearTimeout(timer)
  }
  for (const name of created.reverse()) {
    try { docker('rm', '-f', '-v', name) } catch { console.error(`Unable to remove disposable smoke container ${name}`); process.exitCode = 1 }
  }
}
