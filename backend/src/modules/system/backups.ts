import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, readdir, rename, unlink, stat, mkdtemp, rm, open, statfs } from 'node:fs/promises'
import path from 'node:path'
import pg, { type PoolClient } from 'pg'
import { getConfig } from '../../config.js'
import type { DbClient } from '../../db/index.js'
import type { SessionUser } from '../auth/service.js'
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'
import { consumeAuthorization, digest, seal, secretKey, unseal } from './security.js'
import { coordinationPool, exclusive, operationsLock, writerLock } from './writer-gate.js'

const runFile = promisify(execFile), prefix = Buffer.from('PARSBACKUP1\n')
const keyContext = () => { const c = getConfig(); return digest(c.AUTH_SECRET + ':' + c.STORE_SECRET_KEY + ':' + c.FRONTEND_URL + ':' + c.TABAPAY_MERCHANT + ':' + JSON.stringify(c.PROVIDERS)) }
interface Snapshot { pgMajor: number; schemaHead: string; auditHead: number; financialHash: string; counts: Record<string, number>; instanceId: string; keyContext: string }
interface Header extends Snapshot { id: string; createdAt: string; checksum: string }
export interface BackupJob { id: string; kind: 'backup' | 'upload' | 'rehearsal' | 'restore'; status: string; stage: string; createdAt: string; actorId: string;
  sourceId?: string; approvedBy?: string; size?: number; checksum?: string; snapshot?: Snapshot; restored?: Snapshot; preBackupId?: string; message?: string; expiresAt?: string }
function configured() {
  const c = getConfig()
  if (!c.SYSTEM_BACKUP_ENABLED || !/^[0-9a-f-]{36}$/i.test(c.SYSTEM_INSTANCE_ID)) throw new ValidationError('پشتیبان‌گیری و شناسهٔ مستقل سامانه توسط اپراتور فعال نشده است.')
  secretKey(c.SYSTEM_BACKUP_KEY); secretKey()
  if (!path.isAbsolute(c.SYSTEM_BACKUP_DIR)) throw new ValidationError('مسیر خصوصی Backup باید مطلق باشد.')
  return c
}
const filename = (id: string, ext: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundError()
  return path.join(configured().SYSTEM_BACKUP_DIR, id + ext)
}
async function syncDirectory() { const dir = await open(configured().SYSTEM_BACKUP_DIR, 'r'); try { await dir.sync() } finally { await dir.close() } }
async function save(job: BackupJob) {
  await mkdir(configured().SYSTEM_BACKUP_DIR, { recursive: true, mode: 0o700 })
  const file = filename(job.id, '.json'), tmp = file + '.' + randomUUID() + '.tmp'
  await writeFile(tmp, JSON.stringify(job), { mode: 0o600, flag: 'wx', flush: true }); await rename(tmp, file); await syncDirectory()
}
export async function getBackupJob(id: string): Promise<BackupJob> {
  try { return JSON.parse(await readFile(filename(id, '.json'), 'utf8')) as BackupJob } catch { throw new NotFoundError('عملیات Backup یافت نشد.') }
}
export async function listBackupJobs(limit = 200) {
  const c = configured(); await mkdir(c.SYSTEM_BACKUP_DIR, { recursive: true, mode: 0o700 })
  const names = (await readdir(c.SYSTEM_BACKUP_DIR)).filter(n => /^[0-9a-f-]{36}\.json$/.test(n))
  const jobs = await Promise.all(names.map(n => getBackupJob(n.slice(0, -5))))
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
}
async function snapshot(client: PoolClient): Promise<Snapshot> {
  const pgMajor = Math.floor(Number((await client.query('show server_version_num')).rows[0].server_version_num) / 10000)
  const schemaHead = String((await client.query('select max(created_at) as head from drizzle.__drizzle_migrations')).rows[0].head)
  const counts: Record<string, number> = {}, hash = createHash('sha256')
  // Read under a single exported repeatable-read snapshot when backing up.
  for (const table of ['users', 'tickets', 'wallets', 'wallet_transactions', 'orders', 'order_items', 'order_events', 'invoices', 'invoice_items', 'subscriptions', 'subscription_events', 'renewal_attempts', 'servers', 'provider_operations', 'wallet_payments', 'gateway_credentials', 'admin_adjustments', 'pricing_rules']) {
    counts[table] = Number((await client.query(`select count(*) as n from public.${table}`)).rows[0].n)
    if (table === 'tickets') continue
    let after = ['order_events', 'subscription_events'].includes(table) ? '0' : '00000000-0000-0000-0000-000000000000'
    for (;;) {
      const record = table === 'users' ? `jsonb_build_object('id',id,'email',email,'mobile',mobile,'role',role,'status',status,'password',password_hash,'totp',totp_secret_encrypted,'twoFactor',two_factor_enabled,'recovery',recovery_codes_hash,'emailVerified',email_verified_at,'mobileVerified',mobile_verified_at)` : 'row_to_json(t)'
      const { rows } = await client.query(`select id, ${record} as data from public.${table} t where id > $1 order by id limit 1000`, [after])
      if (!rows.length) break
      for (const row of rows) hash.update(JSON.stringify(row.data))
      after = rows.at(-1).id
    }
  }
  hash.update(JSON.stringify((await client.query('select * from fx_rates order by id')).rows))
  hash.update(JSON.stringify((await client.query('select * from providers order by id')).rows))
  hash.update(JSON.stringify((await client.query("select value from settings where key='tabapay.active'")).rows))
  const auditHead = Number((await client.query('select coalesce(max(id),0) as n from audit_logs')).rows[0].n)
  return { pgMajor, schemaHead, auditHead, financialHash: hash.digest('hex'), counts, instanceId: configured().SYSTEM_INSTANCE_ID,
    keyContext: keyContext() }
}
async function tool(name: 'pg_dump' | 'pg_restore', args: string[], database?: string, outputFile?: string) {
  const url = new URL(getConfig().DATABASE_URL)
  let watchdog: ReturnType<typeof setInterval> | undefined
  try {
    const childProcess = runFile(name, args, { timeout: 600000, maxBuffer: 262144, windowsHide: true,
      env: { PATH: globalThis.process.env.PATH, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database ?? decodeURIComponent(url.pathname.slice(1)),
        PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer', PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c statement_timeout=540000 -c lock_timeout=10000' } })
    if (outputFile) watchdog = setInterval(() => { void stat(outputFile).then(s => { if (s.size > configured().SYSTEM_BACKUP_MAX_MB * 1048576) childProcess.child.kill('SIGTERM') }).catch(() => undefined) }, 250)
    return await childProcess
  } catch { throw new AppError(503, 'backup_tool_failed', 'ابزار PostgreSQL ناموفق بود؛ دسترسی، نسخه و فضای خصوصی Backup را بررسی کنید. جزئیات محرمانه نمایش داده نمی‌شود.') }
  finally { if (watchdog) clearInterval(watchdog) }
}
async function validateTool(major: number) {
  const version = await tool('pg_dump', ['--version'])
  if (Number(version.stdout.match(/\b(\d+)\./)?.[1]) !== major) throw new ConflictError('نسخهٔ اصلی pg_dump و PostgreSQL باید یکسان باشند.')
}
async function decodeArtifact(id: string) {
  const c = configured(), size = (await stat(filename(id, '.sealed'))).size
  if (size > c.SYSTEM_BACKUP_MAX_MB * 1048576 + 65536) throw new ValidationError('Backup بیش از حجم مجاز است.')
  const file = await readFile(filename(id, '.sealed'))
  if (!file.subarray(0, prefix.length).equals(prefix)) throw new ValidationError('فقط آرشیو رمزگذاری‌شدهٔ همین سامانه قابل بازیابی است؛ SQL یا dump خام پذیرفته نمی‌شود.')
  const end = file.indexOf(10, prefix.length)
  if (end < 0 || end > 32768) throw new ValidationError('قالب Backup معتبر نیست.')
  const headerText = file.subarray(prefix.length, end).toString()
  try {
    const dump = unseal(file.subarray(end + 1), headerText, secretKey(c.SYSTEM_BACKUP_KEY)), header = JSON.parse(headerText) as Header
    if (header.instanceId !== c.SYSTEM_INSTANCE_ID || header.keyContext !== keyContext() || digest(dump) !== header.checksum || dump.subarray(0, 5).toString() !== 'PGDMP') throw new Error()
    return { dump, header, checksum: digest(file) }
  } catch { throw new ValidationError('اصالت، Checksum، کلیدهای خارجی یا شناسهٔ سامانهٔ Backup مطابقت ندارد.') }
}
async function makeBackup(client: PoolClient, job: BackupJob) {
  await storageBudget(configured().SYSTEM_BACKUP_MAX_MB * 1048576)
  const c = configured(), dir = await temporary('dump')
  try {
    await client.query('begin isolation level repeatable read read only')
    const details = await snapshot(client); await validateTool(details.pgMajor)
    job.stage = 'dumping'; await save(job)
    const exported = (await client.query('select pg_export_snapshot() as snapshot')).rows[0].snapshot
    const file = path.join(dir, 'data.dump')
    // Excluded session/challenge data prevents restoring revoked access grants.
    await tool('pg_dump', ['-Fc', '--no-owner', '--no-acl', '--schema=public', '--schema=drizzle',
      '--exclude-table-data=public.sessions', '--exclude-table-data=public.auth_challenges', '--exclude-table-data=public.admin_authorizations', `--snapshot=${exported}`, '--file', file], undefined, file)
    await client.query('commit')
    if ((await stat(file)).size > c.SYSTEM_BACKUP_MAX_MB * 1048576) throw new ValidationError('حجم Backup بیش از سقف پیکربندی‌شده است.')
    const dump = await readFile(file), header: Header = { ...details, id: job.id, createdAt: job.createdAt, checksum: digest(dump) }
    const text = JSON.stringify(header), sealed = Buffer.concat([prefix, Buffer.from(text + '\n'), seal(dump, text, secretKey(c.SYSTEM_BACKUP_KEY))])
    await writeFile(filename(job.id, '.sealed'), sealed, { flag: 'wx', mode: 0o600, flush: true })
    Object.assign(job, { size: sealed.length, checksum: digest(sealed), snapshot: details, status: 'completed', stage: 'encrypted' })
    await save(job); await decodeArtifact(job.id)
  } finally { await client.query('rollback').catch(() => undefined); await removeTemp(dir) }
}
async function removeTemp(dir: string) {
  const root = path.resolve('/dev/shm')
  if (path.dirname(path.resolve(dir)) !== root || !/^parserver-(dump|restore|live)-/.test(path.basename(dir))) throw new Error('Refusing invalid temporary path')
  await rm(dir, { recursive: true, force: true })
}
async function temporary(kind: 'dump' | 'restore' | 'live') {
  const filesystem = await statfs('/dev/shm')
  if (filesystem.type !== 0x01021994 || Number(filesystem.bavail) * Number(filesystem.bsize) < configured().SYSTEM_BACKUP_MAX_MB * 1048576) throw new ConflictError('فضای موقت RAM کافی نیست؛ API باید با tmpfs و shm_size سازگار اجرا شود. Dump خام روی دیسک نوشته نمی‌شود.')
  return mkdtemp(path.join('/dev/shm', 'parserver-' + kind + '-'))
}
async function currentSnapshot(client: PoolClient) {
  await client.query('begin isolation level repeatable read read only')
  try { return await snapshot(client) } finally { await client.query('rollback') }
}
async function rehearse(client: PoolClient, source: string, job: BackupJob) {
  const { dump, header } = await decodeArtifact(source), live = await currentSnapshot(client)
  if (live.pgMajor !== header.pgMajor || live.schemaHead !== header.schemaHead) throw new ConflictError('نسخهٔ PostgreSQL یا schema یکسان نیست؛ ابتدا برنامهٔ سازگار را انتخاب کنید.')
  await validateTool(live.pgMajor)
  const name = 'parserver_restore_' + randomUUID().replaceAll('-', ''), dir = await temporary('restore')
  const file = path.join(dir, 'data.dump'), url = new URL(getConfig().DATABASE_URL)
  let created = false
  try {
    await writeFile(file, dump, { mode: 0o600, flag: 'wx' })
    await client.query(`create database "${name}" template template0`); created = true
    await tool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', name, file], name)
    url.pathname = '/' + name
    const isolated = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 10000 })
    let temporary: PoolClient | undefined
    try {
      temporary = await isolated.connect()
      const restored = await currentSnapshot(temporary)
      if (restored.schemaHead !== header.schemaHead || restored.financialHash !== header.financialHash) throw new ConflictError('صحت‌سنجی دفتر مالی یا schema در بازیابی آزمایشی ناموفق بود.')
      // Ledger invariant: the last ledger balance must match its wallet.
      const invalid = await temporary.query(`select 1 from wallets w join lateral (select balance_after_rial from wallet_transactions where wallet_id=w.id order by created_at desc,id desc limit 1) t on true where w.balance_rial<>t.balance_after_rial or w.balance_rial<0 limit 1`)
      if (invalid.rowCount) throw new ConflictError('تطبیق دفتر مالی در بازیابی آزمایشی ناموفق بود.')
      job.snapshot = live; job.restored = restored
    } finally { temporary?.release(true); await isolated.end() }
  } finally {
    if (created) await client.query(`drop database "${name}" with (force)`)
    await removeTemp(dir)
  }
  return { header, dump }
}
const pending = (id: string, kind: BackupJob['kind'], actorId: string, sourceId?: string): BackupJob => ({ id, kind, actorId, sourceId, createdAt: new Date().toISOString(), status: 'queued', stage: 'queued' })
const running = new Set<Promise<void>>()
function schedule(db: DbClient, job: BackupJob) {
  const task = run(db, job).catch(() => undefined).finally(() => running.delete(task)); running.add(task)
}
async function run(db: DbClient, job: BackupJob) {
  const pool = coordinationPool(1)
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    await exclusive(client, operationsLock)
    job.status = 'running'; job.stage = 'preflight'; await save(job)
    if (job.kind === 'backup') { await retention(db); await makeBackup(client, job) }
    else if (job.kind === 'rehearsal') { await rehearse(client, job.sourceId!, job); job.status = 'completed'; job.stage = 'verified'; job.expiresAt = new Date(Date.now() + 15 * 60000).toISOString(); await save(job) }
    else if (job.kind === 'restore') {
      // Queue the exclusive lock, drain the initiating HTTP request and in-flight
      // jobs. Waiting is bounded; no service or host process is restarted.
      await client.query("set statement_timeout='60s'")
      await client.query('select pg_advisory_lock($1,$2)', [...writerLock])
      await client.query('set statement_timeout=0')
      const candidate = await getBackupJob(job.sourceId!)
      if (candidate.kind !== 'rehearsal' || candidate.status !== 'completed' || !candidate.expiresAt || Date.parse(candidate.expiresAt) < Date.now()) throw new ConflictError('بازیابی آزمایشی موفق و تازه لازم است.')
      const live = await currentSnapshot(client), original = await decodeArtifact(candidate.sourceId!)
      if (live.financialHash !== original.header.financialHash || live.schemaHead !== original.header.schemaHead || live.pgMajor !== original.header.pgMajor) throw new ConflictError('دفتر مالی، سفارش‌ها، schema یا اعتبارنامه‌ها از زمان Backup تغییر کرده‌اند؛ تطبیق و بازیابی آفلاین لازم است.')
      if (JSON.stringify(live.counts) !== JSON.stringify(candidate.snapshot?.counts)) throw new ConflictError('خلاصهٔ تغییرات از زمان آزمایش بازیابی عوض شده است؛ آزمایش تازه و تأیید دوباره لازم است.')
      const administrators = await client.query("select id from users where id=any($1::uuid[]) and role='admin' and status='active'", [[job.actorId, job.approvedBy]])
      if (administrators.rowCount !== 2 || job.actorId === job.approvedBy) throw new ForbiddenError('دسترسی یکی از مدیران تأییدکننده لغو شده است.')
      const active = await client.query("select 1 from wallet_payments where status in ('creating','pending','unknown') union all select 1 from provider_operations where status in ('pending','running','unknown','needs_reconciliation') union all select 1 from orders where status::text in ('pending_payment','paid','queued','provisioning','requires_review') limit 1")
      if (active.rowCount) throw new ConflictError('پرداخت یا عملیات سرویس‌دهندهٔ تعیین‌تکلیف‌نشده مانع Restore است.')
      const auditDelta = (await client.query('select * from audit_logs where id > $1 order by id limit 50001', [original.header.auditHead])).rows
      if (auditDelta.length > 50000) throw new ConflictError('حجم Audit جدید به بازیابی و تطبیق آفلاین نیاز دارد.')
      job.stage = 'pre_backup'; await save(job)
      const safety = pending(randomUUID(), 'backup', job.actorId); await makeBackup(client, safety)
      // Require an ACTUAL successful rehearsal of the rollback file before writing.
      await rehearse(client, safety.id, pending(randomUUID(), 'rehearsal', job.actorId, safety.id))
      job.preBackupId = safety.id; job.stage = 'restoring'; await save(job)
      await writeFile(path.join(configured().SYSTEM_BACKUP_DIR, 'maintenance.lock'), JSON.stringify({ jobId: job.id, preBackupId: safety.id }), { flag: 'wx', mode: 0o600, flush: true }); await syncDirectory()
      const dir = await temporary('live')
      try {
        const file = path.join(dir, 'data.dump'); await writeFile(file, original.dump, { mode: 0o600 })
        try {
          await tool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', new URL(getConfig().DATABASE_URL).pathname.slice(1), file])
          const after = await currentSnapshot(client)
          if (after.financialHash !== original.header.financialHash || after.schemaHead !== original.header.schemaHead) throw new Error('postcheck failed')
          await client.query('begin')
          try {
            for (const row of auditDelta) await client.query(`insert into audit_logs(id,actor_id,action,target_type,target_id,metadata,ip,created_at) overriding system value values ($1,(select id from users where id=$2),$3,$4,$5,$6,$7,$8) on conflict(id) do nothing`,
              [row.id, row.actor_id, row.action, row.target_type, row.target_id, { ...row.metadata, originalActorId: row.actor_id }, row.ip, row.created_at])
            await client.query("select setval(pg_get_serial_sequence('audit_logs','id'), greatest((select coalesce(max(id),1) from audit_logs),1))")
            await client.query('commit')
          } catch (error) { await client.query('rollback'); throw error }
          job.restored = after
        } catch {
          job.stage = 'rollback'; await save(job)
          await writeFile(file, (await decodeArtifact(safety.id)).dump, { mode: 0o600 })
          await tool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', new URL(getConfig().DATABASE_URL).pathname.slice(1), file])
          if ((await currentSnapshot(client)).financialHash !== safety.snapshot!.financialHash) throw new Error('rollback verification failed')
          await unlink(path.join(configured().SYSTEM_BACKUP_DIR, 'maintenance.lock'))
          throw new ConflictError('بازیابی ناموفق بود؛ Backup پیش از عملیات با موفقیت بازگردانده شد.')
        }
      } finally { await removeTemp(dir) }
      job.status = 'completed'; job.stage = 'verified'; await save(job)
    }
    await writeAudit(db, { action: 'system.' + job.kind + '_completed', targetType: 'system_operation', targetId: job.id, metadata: { backupId: job.id, requestedBy: job.actorId, approvedBy: job.approvedBy, result: 'success' } })
    if (job.kind === 'restore') await unlink(path.join(configured().SYSTEM_BACKUP_DIR, 'maintenance.lock'))
  } catch (error) {
    job.status = 'failed'; job.message = error instanceof AppError ? error.message : 'عملیات ناموفق یا نیازمند بررسی اپراتور است؛ اطلاعات محرمانه نمایش داده نمی‌شود.'
    await save(job)
    await writeAudit(db, { action: 'system.' + job.kind + '_failed', targetType: 'system_operation', targetId: job.id, metadata: { backupId: job.id, result: 'failed' } }).catch(() => undefined)
  } finally { client?.release(true); await pool.end() }
}
export async function requestBackupJob(db: DbClient, user: SessionUser, kind: 'backup' | 'rehearsal', sourceId: string | undefined, proof: string) {
  configured()
  const payload = kind === 'backup' ? { confirm: true } : { sourceId, confirm: true }
  const job = pending(randomUUID(), kind, user.id, sourceId)
  await db.transaction(async tx => { await consumeAuthorization(tx, user, proof, 'backup.' + kind, payload); await writeAudit(tx, { actorId: user.id, action: 'system.' + kind + '_requested', targetType: 'system_operation', targetId: job.id }) })
  await save(job); schedule(db, job); return job
}
export async function importBackup(db: DbClient, user: SessionUser, data: Buffer, proof: string) {
  const pool = coordinationPool(1), client = await pool.connect()
  try {
  await exclusive(client, operationsLock)
  const c = configured()
  if (data.length > c.SYSTEM_BACKUP_MAX_MB * 1048576 + 65536) throw new ValidationError('حجم فایل بیش از سقف مجاز است.')
  await storageBudget(data.length)
  await db.transaction(tx => consumeAuthorization(tx, user, proof, 'backup.upload', { checksum: digest(data), size: data.length, confirm: true }))
  const job = pending(randomUUID(), 'upload', user.id)
  await mkdir(c.SYSTEM_BACKUP_DIR, { recursive: true, mode: 0o700 })
  await writeFile(filename(job.id, '.sealed'), data, { flag: 'wx', mode: 0o600, flush: true })
  try { const decoded = await decodeArtifact(job.id); job.snapshot = decoded.header; job.checksum = decoded.checksum; job.size = data.length; job.status = 'completed'; job.stage = 'authenticated'; await save(job) }
  catch (error) { await unlink(filename(job.id, '.sealed')); throw error }
  await writeAudit(db, { actorId: user.id, action: 'system.backup_uploaded', targetType: 'system_operation', targetId: job.id })
  return job
  } finally { client.release(true); await pool.end() }
}
export async function requestRestore(db: DbClient, user: SessionUser, rehearsalId: string, proof: string) {
  if (!configured().SYSTEM_RESTORE_ENABLED) throw new ForbiddenError('Restore روی این میزبان توسط اپراتور فعال نشده است.')
  const candidate = await getBackupJob(rehearsalId)
  if (candidate.kind !== 'rehearsal' || candidate.status !== 'completed') throw new ConflictError('ابتدا بازیابی آزمایشی موفق انجام دهید.')
  const job = pending(randomUUID(), 'restore', user.id, rehearsalId); job.status = 'awaiting_approval'; job.expiresAt = new Date(Date.now() + 10 * 60000).toISOString()
  await db.transaction(async tx => { await consumeAuthorization(tx, user, proof, 'backup.restore', { rehearsalId, confirm: 'RESTORE DATABASE' }); await writeAudit(tx, { actorId: user.id, action: 'system.restore_requested', targetType: 'system_operation', targetId: job.id }) })
  await save(job); return job
}
export async function approveRestore(db: DbClient, user: SessionUser, id: string, proof: string) {
  configured()
  const pool = coordinationPool(1), client = await pool.connect()
  try {
    await exclusive(client, operationsLock)
    const job = await getBackupJob(id)
    if (!getConfig().SYSTEM_RESTORE_ENABLED || job.kind !== 'restore' || job.status !== 'awaiting_approval' || !job.expiresAt || Date.parse(job.expiresAt) < Date.now() || job.actorId === user.id) throw new ForbiddenError('درخواست معتبر، فعال و تأیید مدیر دوم لازم است.')
    await db.transaction(async tx => { await consumeAuthorization(tx, user, proof, 'backup.approve', { id, confirm: 'RESTORE DATABASE' }); await writeAudit(tx, { actorId: user.id, action: 'system.restore_approved', targetType: 'system_operation', targetId: id }) })
    job.approvedBy = user.id; job.status = 'queued'; await save(job)
    // Start after this HTTP request releases its shared writer gate.
    setImmediate(() => schedule(db, job)); return job
  } finally { client.release(true); await pool.end() }
}
export async function removeBackup(db: DbClient, user: SessionUser, id: string, proof: string) {
  const pool = coordinationPool(1), client = await pool.connect()
  try {
    await exclusive(client, operationsLock)
    const job = await getBackupJob(id)
    if (!['backup', 'upload'].includes(job.kind) || !['completed', 'failed'].includes(job.status)) throw new ConflictError('فقط فایل Backup غیرفعال قابل حذف است؛ سوابق عملیات حفظ می‌شوند.')
    const references = await listBackupJobs(Number.MAX_SAFE_INTEGER)
    if (references.some(j => (j.preBackupId === id || j.sourceId === id) && (['running', 'queued', 'awaiting_approval'].includes(j.status) || j.status === 'failed' && j.preBackupId === id || j.expiresAt && Date.parse(j.expiresAt) > Date.now()))) throw new ConflictError('این Backup مرجع بازیابی یا Rollback است؛ حذف آن مجاز نیست.')
    await db.transaction(async tx => { await consumeAuthorization(tx, user, proof, 'backup.delete', { id, confirm: true }); await writeAudit(tx, { actorId: user.id, action: 'system.backup_deleted', targetType: 'system_operation', targetId: id }) })
    await unlink(filename(id, '.sealed')).catch(() => undefined); job.status = 'deleted'; job.stage = 'deleted'; await save(job)
  } finally { client.release(true); await pool.end() }
}
export const backupFile = async (id: string) => { await decodeArtifact(id); return filename(id, '.sealed') }
export async function waitBackupJobs() { await Promise.allSettled([...running]) }
async function storageBudget(extra: number) {
  const c = configured(); await mkdir(c.SYSTEM_BACKUP_DIR, { recursive: true, mode: 0o700 })
  let used = 0
  for (const file of await readdir(c.SYSTEM_BACKUP_DIR)) if (/^[0-9a-f-]{36}\.sealed$/.test(file)) used += (await stat(path.join(c.SYSTEM_BACKUP_DIR, file))).size
  if (used + extra > c.SYSTEM_BACKUP_MAX_TOTAL_MB * 1048576) throw new ConflictError('سقف فضای خصوصی Backup پر شده است؛ ابتدا نسخهٔ غیرضروری را با تأیید امن حذف کنید.')
}
async function retention(db: DbClient) {
  const jobs = await listBackupJobs(Number.MAX_SAFE_INTEGER), cutoff = Date.now() - configured().SYSTEM_BACKUP_RETENTION_DAYS * 86400000
  const protectedIds = new Set(jobs.flatMap(j => ['running', 'queued', 'awaiting_approval', 'failed', 'interrupted'].includes(j.status) || j.expiresAt && Date.parse(j.expiresAt) > Date.now() ? [j.sourceId, j.preBackupId].filter(Boolean) : []))
  for (const job of jobs) if (['backup', 'upload'].includes(job.kind) && job.status === 'completed' && Date.parse(job.createdAt) < cutoff && !protectedIds.has(job.id)) {
    await unlink(filename(job.id, '.sealed')); job.status = 'deleted'; job.stage = 'retention_expired'; await save(job)
    await writeAudit(db, { action: 'system.backup_retention_deleted', targetType: 'system_operation', targetId: job.id })
  }
}
export async function initializeBackupJobs() {
  if (!getConfig().SYSTEM_BACKUP_ENABLED || running.size) return
  const pool = coordinationPool(1), client = await pool.connect()
  try {
    try { await exclusive(client, operationsLock) } catch { return } // Another healthy process owns an operation.
    for (const job of await listBackupJobs(Number.MAX_SAFE_INTEGER)) if (['queued', 'running'].includes(job.status)) {
      job.status = 'interrupted'; job.message = 'پردازش قبلی قطع شد؛ خودکار تکرار نمی‌شود. در صورت وجود maintenance.lock بازیابی آفلاین اپراتور لازم است.'; await save(job)
    }
  } finally { client.release(true); await pool.end() }
}
/** Offline, explicit recovery only. The durable sentinel keeps API/jobs blocked
 * through crashes and failed rollback; deleting it is never the recovery step. */
export async function recoverBackupJob(db: DbClient, id: string, confirmed: boolean) {
  const marker = JSON.parse(await readFile(path.join(configured().SYSTEM_BACKUP_DIR, 'maintenance.lock'), 'utf8')) as { jobId: string; preBackupId: string }
  if (marker.jobId !== id) throw new ConflictError('شناسهٔ Recovery با فایل Maintenance مطابقت ندارد.')
  const job = await getBackupJob(id), safety = await decodeArtifact(marker.preBackupId)
  if (!confirmed) return { id, status: job.status, preBackupId: marker.preBackupId, schemaHead: safety.header.schemaHead, action: 'explicit_rollback_confirmation_required' }
  const pool = coordinationPool(1)
  let client: PoolClient | undefined, dir: string | undefined
  try {
    client = await pool.connect(); dir = await temporary('live')
    await exclusive(client, operationsLock); await exclusive(client, writerLock)
    await rehearse(client, marker.preBackupId, pending(randomUUID(), 'rehearsal', job.actorId, marker.preBackupId))
    const file = path.join(dir, 'data.dump'); await writeFile(file, safety.dump, { mode: 0o600 })
    await tool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', new URL(getConfig().DATABASE_URL).pathname.slice(1), file])
    const restored = await currentSnapshot(client)
    if (restored.financialHash !== safety.header.financialHash || restored.schemaHead !== safety.header.schemaHead) throw new ConflictError('Recovery تأیید نشد؛ Maintenance فعال باقی می‌ماند.')
    job.status = 'rolled_back'; job.stage = 'verified'; job.message = 'Backup پیش از عملیات با تأیید آفلاین اپراتور بازیابی شد.'; await save(job)
    await writeAudit(db, { action: 'system.offline_recovery_completed', targetType: 'system_operation', targetId: job.id, metadata: { backupId: marker.preBackupId, result: 'success' } })
    await unlink(path.join(configured().SYSTEM_BACKUP_DIR, 'maintenance.lock'))
    return { id, status: job.status }
  } finally { client?.release(true); await pool.end(); if (dir) await removeTemp(dir) }
}
