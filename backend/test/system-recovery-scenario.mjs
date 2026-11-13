// Runs INSIDE the built non-root image against a dedicated disposable database.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { loadConfig, getConfig } from './dist/config.js'
import { createDb } from './dist/db/index.js'
import { migrate } from './dist/db/migrate.js'
import { users, tickets } from './dist/db/schema.js'
import { buildApp } from './dist/app.js'
import { createLogger } from './dist/logger.js'
import { hashPassword, createSession } from './dist/modules/auth/service.js'
import { createTotpSecret, encryptTotpSecret, generateTotpCode } from './dist/modules/auth/totp.js'
import { ensureDefaultWallet, creditWallet } from './dist/modules/wallets/service.js'
import { issueAuthorization, digest } from './dist/modules/system/security.js'
import { requestBackupJob, waitBackupJobs, getBackupJob, importBackup, requestRestore, approveRestore, recoverBackupJob, initializeBackupJobs } from './dist/modules/system/backups.js'
import { coordinationPool, sharedWriter } from './dist/modules/system/writer-gate.js'
import { createCloudQueues, JOB_NAMES } from './dist/jobs/queue.js'
import { createWorkers } from './dist/jobs/workers.js'

loadConfig(); await migrate()
const handle = createDb(), db = handle.db, config = getConfig(), password = 'Smoke-fixture-only-123!'
const allowed = config.SYSTEM_ADMIN_IDS.split(','), accounts = []
for (let index = 0; index < 3; index++) {
  const id = allowed[index] || randomUUID(), secret = createTotpSecret(), email = `fixture-${index}@example.test`
  await db.insert(users).values({ id, email, passwordHash: await hashPassword(password), role: index < 2 ? 'admin' : 'user', status: 'active',
    twoFactorEnabled: true, totpSecretEncrypted: encryptTotpSecret(secret) })
  const session = await createSession(db, id, {})
  accounts.push({ id, secret, sessionId: session.sessionId, token: session.token, email, role: index < 2 ? 'admin' : 'user', status: 'active' })
}
let [a, b, customer] = accounts
const wallet = await ensureDefaultWallet(db, customer.id)
await creditWallet(db, customer.id, wallet.id, 100000, { idempotencyKey: 'fixture-opening-credit' })
const authorize = async (actor, action, payload) => (await issueAuthorization(db, actor, action, payload, password, generateTotpCode(actor.secret))).proof
async function refreshSessions() { for (const actor of [a, b]) { const session = await createSession(db, actor.id, {}); actor.sessionId = session.sessionId; actor.token = session.token } }
async function jobDone(id) {
  const deadline = Date.now() + 120000
  for (;;) { const job = await getBackupJob(id); if (!['queued', 'running'].includes(job.status)) return job; assert.ok(Date.now() < deadline, 'job timeout'); await delay(50) }
}
let app
try {
  const guard = spawn(process.execPath, ['dist/modules/system/deploy-guard.js'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let guardReady = false
  guard.stdout.on('data', data => { if (String(data).includes('SYSTEM_DEPLOY_GUARD_READY')) guardReady = true })
  const guardExit = new Promise(resolve => guard.once('exit', resolve))
  try {
    const deadline = Date.now() + 10000
    while (!guardReady) { assert.ok(Date.now() < deadline, 'real deployment guard must become ready'); await delay(50) }
    const busy = await requestBackupJob(db, a, 'backup', undefined, await authorize(a, 'backup.backup', { confirm: true }))
    const refused = await jobDone(busy.id)
    assert.equal(refused.status, 'failed'); assert.match(refused.message, /عملیات دیگری/)
  } finally { guard.kill('SIGTERM'); await guardExit }
  const backup = await requestBackupJob(db, a, 'backup', undefined, await authorize(a, 'backup.backup', { confirm: true }))
  await waitBackupJobs(); const completed = await getBackupJob(backup.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  assert.equal(completed.snapshot.pgMajor, 17)
  const sealed = await readFile(`${config.SYSTEM_BACKUP_DIR}/${backup.id}.sealed`)
  assert.equal(sealed.includes(Buffer.from(customer.email)), false)
  const queues = new Proxy({}, { get: () => async () => undefined })
  app = await buildApp({ db, queues, logger: createLogger('system-smoke') }); await app.ready()
  const downloadProof = await authorize(a, 'backup.download', { id: backup.id, confirm: true })
  const download = () => app.inject({ method: 'POST', url: `/api/admin/settings/backups/${backup.id}/download`, headers: { authorization: `Bearer ${a.token}` }, payload: { proof: downloadProof, confirm: true } })
  const downloaded = await download(); assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.rawPayload, sealed)
  assert.equal((await download()).statusCode, 403)
  const corrupt = Buffer.from(sealed); corrupt[corrupt.length - 1] ^= 1
  await assert.rejects(importBackup(db, a, corrupt, await authorize(a, 'backup.upload', { checksum: digest(corrupt), size: corrupt.length, confirm: true })), /اصالت|Checksum/)
  const sql = Buffer.from('DROP DATABASE customers;')
  await assert.rejects(importBackup(db, a, sql, await authorize(a, 'backup.upload', { checksum: digest(sql), size: sql.length, confirm: true })), /آرشیو|SQL/)
  const uploaded = await importBackup(db, a, sealed, await authorize(a, 'backup.upload', { checksum: digest(sealed), size: sealed.length, confirm: true }))
  assert.equal(uploaded.status, 'completed')
  await db.insert(tickets).values({ userId: customer.id, title: 'New non-financial fixture ticket', department: 'technical' })
  const rehearsal = await requestBackupJob(db, a, 'rehearsal', backup.id, await authorize(a, 'backup.rehearsal', { sourceId: backup.id, confirm: true }))
  assert.equal((await jobDone(rehearsal.id)).status, 'completed', JSON.stringify(await getBackupJob(rehearsal.id)))
  async function restoreAttempt() {
    const job = await requestRestore(db, a, rehearsal.id, await authorize(a, 'backup.restore', { rehearsalId: rehearsal.id, confirm: 'RESTORE DATABASE' }))
    await assert.rejects(approveRestore(db, a, job.id, await authorize(a, 'backup.approve', { id: job.id, confirm: 'RESTORE DATABASE' })), /مدیر دوم/)
    await approveRestore(db, b, job.id, await authorize(b, 'backup.approve', { id: job.id, confirm: 'RESTORE DATABASE' }))
    return jobDone(job.id)
  }
  // Simulate a lost success acknowledgement AFTER the primary restore commits.
  // The fallback must actually restore the pre-operation ticket, not just report
  // that a failed pg_restore left its transaction untouched.
  // Docker's private backup tmpfs is intentionally noexec. Fixture wrappers
  // live in the disposable container's /tmp, never in the backup volume.
  const bin = '/tmp/fixture-system-tools'; await mkdir(bin, { mode: 0o700 })
  const realRestore = '/usr/libexec/postgresql17/pg_restore'
  await access(realRestore)
  await writeFile(bin + '/pg_restore', `#!/bin/sh\ncase " $* " in *" --dbname fixture "*) if [ ! -f '${bin}/used' ]; then '${realRestore}' "$@" || exit $?; touch '${bin}/used'; exit 7; fi;; esac\nexec '${realRestore}' "$@"\n`, { mode: 0o700 })
  const originalPath = process.env.PATH; process.env.PATH = bin + ':' + originalPath
  const rolledBack = await restoreAttempt(); process.env.PATH = originalPath
  assert.equal(rolledBack.status, 'failed', JSON.stringify(rolledBack)); assert.match(rolledBack.message, /بازگردانده/)
  assert.equal((await db.select().from(tickets)).length, 1)
  assert.ok(rolledBack.preBackupId)
  // Simulate a crash with an unresolved durable marker; automatic replay is
  // forbidden. Explicit offline Recovery must verify the safety backup first.
  await writeFile(config.SYSTEM_BACKUP_DIR + '/maintenance.lock', JSON.stringify({ jobId: rolledBack.id, preBackupId: rolledBack.preBackupId }), { mode: 0o600 })
  const interrupted = { ...rolledBack, status: 'running' }
  await writeFile(`${config.SYSTEM_BACKUP_DIR}/${rolledBack.id}.json`, JSON.stringify(interrupted), { mode: 0o600 })
  await initializeBackupJobs(); assert.equal((await getBackupJob(rolledBack.id)).status, 'interrupted')
  const gate = coordinationPool(1)
  await assert.rejects(sharedWriter(gate), /Recovery|بازیابی/); await gate.end()
  assert.equal((await app.inject('/api/health/ready')).statusCode, 503)
  const realQueues = await createCloudQueues(), workers = createWorkers({ db, queues: realQueues, logger: createLogger('worker-smoke') })
  try {
    await Promise.all(workers.workers.map(worker => worker.waitUntilReady()))
    for (const worker of workers.workers) void worker.run()
    const queue = realQueues.queue(JOB_NAMES.CATALOG_SYNC), job = await queue.add('fixture-maintenance', { provider: 'fixture-no-provider' }, { attempts: 5 })
    const deadline = Date.now() + 10000
    while (await job.getState() !== 'delayed') { assert.ok(Date.now() < deadline, 'maintenance job must be delayed'); await delay(50) }
    assert.equal((await queue.getJob(job.id)).attemptsMade, 0, 'maintenance must not consume retry attempts')
  } finally { await workers.close(); await realQueues.close() }
  assert.equal((await recoverBackupJob(db, rolledBack.id, false)).action, 'explicit_rollback_confirmation_required')
  assert.equal((await recoverBackupJob(db, rolledBack.id, true)).status, 'rolled_back')
  await refreshSessions()
  const success = await restoreAttempt()
  assert.equal(success.status, 'completed', JSON.stringify(success))
  assert.equal((await db.select().from(tickets)).length, 0)
  assert.equal((await db.query.wallets.findFirst({ where: t => eq(t.id, wallet.id) })).balanceRial, 100000)
  assert.equal((await db.query.sessions.findMany()).length, 0, 'revoked grants are never revived')
  assert.equal((await access(config.SYSTEM_BACKUP_DIR + '/maintenance.lock').then(() => true, () => false)), false)
  await refreshSessions()
  await creditWallet(db, customer.id, wallet.id, 1, { idempotencyKey: 'fixture-new-money' })
  const refused = await restoreAttempt()
  assert.equal(refused.status, 'failed'); assert.match(refused.message, /دفتر مالی/)
  assert.equal((await db.query.wallets.findFirst({ where: t => eq(t.id, wallet.id) })).balanceRial, 100001)
  assert.equal((await handle.pool.query("select datname from pg_database where datname like 'parserver_restore_%'")).rowCount, 0)
  assert.equal((await readdir(config.SYSTEM_BACKUP_DIR)).some(n => /^\.(dump|restore|live)-/.test(n)), false)
  assert.equal((await readdir('/dev/shm')).some(n => /^parserver-(dump|restore|live)-/.test(n)), false)
  console.log('PASS: real PostgreSQL backup, authenticated upload/download, rehearsal, two-person restore, rollback, offline recovery, deployment exclusion, paused-worker retries, financial drift refusal and cleanup')
} finally { await app?.close(); await waitBackupJobs(); await handle.pool.end() }
