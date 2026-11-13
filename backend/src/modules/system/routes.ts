import { createReadStream } from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { adminAdjustments, users, wallets } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { requireAdmin, extractToken } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import { isSiteAuthority } from '../integration/authority.js'
import { writeAudit } from '../audit/service.js'
import { issueAuthorization, consumeAuthorization, systemAdmin } from './security.js'
import { verifyPassword, authenticateToken } from '../auth/service.js'
import { createTotpSecret, createRecoveryCodes, hashRecoveryCode, encryptTotpSecret, decryptTotpSecret, verifyTotp } from '../auth/totp.js'
import { safeMetadata } from './events.js'
import { diagnoseGateway, gatewayStatus, updateGateway } from './gateway.js'
import { adjustmentSchema, approveAdjustment, findFinancialUser, requestAdjustment } from './finance.js'
import { approveRestore, backupFile, getBackupJob, importBackup, listBackupJobs, removeBackup, requestBackupJob, requestRestore, waitBackupJobs, initializeBackupJobs } from './backups.js'

const idParam = z.object({ id: z.string().uuid() })
const proofSchema = z.string().uuid()
const confirm = z.object({ confirm: z.literal(true), proof: proofSchema }).strict()
const actions = z.enum(['gateway.update', 'gateway.diagnose', 'wallet.adjust', 'wallet.approve', 'logs.export', 'backup.backup', 'backup.rehearsal', 'backup.upload', 'backup.download', 'backup.delete', 'backup.restore', 'backup.approve'])
const gatewaySchema = z.object({ enabled: z.boolean(), sandbox: z.boolean(), merchant: z.string().uuid().optional(), version: z.string().regex(/^[0-9a-f]{64}$/).optional(), confirm: z.literal(true) }).strict()
const paging = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) })
const logsQuery = paging.extend({ level: z.enum(['', 'info', 'warn', 'error']).default(''), service: z.string().regex(/^[a-zA-Z0-9_-]{0,40}$/).default(''),
  actorId: z.union([z.literal(''), z.string().uuid()]).default(''), event: z.string().max(100).default(''), search: z.string().max(100).default(''), from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
const publicJob = (job: Awaited<ReturnType<typeof getBackupJob>>) => {
  const summary = (snapshot: typeof job.snapshot) => snapshot ? { pgMajor: snapshot.pgMajor, schemaHead: snapshot.schemaHead, counts: snapshot.counts } : undefined
  return { ...job, snapshot: summary(job.snapshot), restored: summary(job.restored) }
}
async function logs(db: AppContext['db'], input: z.infer<typeof logsQuery>, limit = input.limit) {
  const where = and(input.level ? sql`e.level=${input.level}` : undefined, input.service ? sql`e.service=${input.service}` : undefined,
    input.actorId ? sql`e.actor_id::text=${input.actorId}` : undefined, input.event ? sql`e.event=${input.event}` : undefined,
    input.search ? sql`(e.event ilike ${'%' + input.search + '%'} or e.request_id ilike ${'%' + input.search + '%'})` : undefined,
    input.from ? sql`e.created_at>=${input.from}::timestamptz` : undefined, input.to ? sql`e.created_at<=${input.to}::timestamptz` : undefined) ?? sql`true`
  const source = sql`(select 'audit:'||id as id, created_at, case when action like '%failed%' or action like '%denied%' then 'error' else 'info' end as level, 'audit' as service, action as event, actor_id, null::text as request_id, metadata from audit_logs
    union all select 'event:'||id::text, created_at, level, service, event, null::uuid, request_id, metadata from system_events) e`
  const result = await db.execute(sql`select * from ${source} where ${where} order by e.created_at desc, e.id desc limit ${limit} offset ${(input.page - 1) * input.limit}`)
  const count = await db.execute(sql`select count(*)::int as n from ${source} where ${where}`)
  return { items: result.rows.map(r => ({ id: r.id, createdAt: r.created_at, level: r.level, service: r.service, event: r.event,
    actorId: r.actor_id, requestId: r.request_id, metadata: safeMetadata(r.metadata), summary: String(r.event).replaceAll('_', ' ') })), total: Number(count.rows[0]?.n ?? 0), page: input.page, limit, pages: Math.ceil(Number(count.rows[0]?.n ?? 0) / input.limit) }
}
export const registerSystemRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx: { db } }) => {
  const max = getConfig().SYSTEM_BACKUP_MAX_MB * 1048576 + 65536
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: max }, (_req, body, done) => done(null, body))
  app.addHook('onRequest', async request => {
    if (!request.url.split('?')[0]?.endsWith('/backups/upload')) return
    const user = await authenticateToken(db, extractToken(request))
    if (!user) throw new UnauthorizedError()
    systemAdmin(user) // Reject before buffering a large upload.
  })
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer')
    const admin = requireAdmin(request)
    if (!isSiteAuthority()) throw new ForbiddenError('مدیریت سیستم تنها در حالت مرجع سایت در دسترس است.')
    if (request.routeOptions.url?.endsWith('/capabilities')) return
    systemAdmin(admin)
  })
  app.addHook('onClose', waitBackupJobs)
  app.get('/capabilities', async request => {
    const c = getConfig(), user = requireAdmin(request)
    let allowed = true
    try { systemAdmin(user) } catch { allowed = false }
    const account = allowed ? await db.query.users.findFirst({ where: t => eq(t.id, user.id) }) : null
    return { data: { allowed, mfaEnabled: !!account?.twoFactorEnabled, encryptionReady: /^[a-f0-9]{64}$/i.test(c.STORE_SECRET_KEY), backupsEnabled: c.SYSTEM_BACKUP_ENABLED,
      restoreEnabled: c.SYSTEM_RESTORE_ENABLED, maxUploadBytes: max, dualApprovalRial: c.SYSTEM_DUAL_APPROVAL_RIAL,
      requirements: ['STORE_SECRET_KEY', 'SYSTEM_BACKUP_KEY', 'SYSTEM_INSTANCE_ID', 'SYSTEM_BACKUP_ENABLED', 'TOTP'] } }
  })
  // Admin step-up MFA is independent of the optional customer-login toggle.
  // Password is mandatory for bootstrap; an already enabled key cannot be replaced.
  app.post('/mfa/setup', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async request => {
    const { password } = parse(z.object({ password: z.string().min(1).max(1024) }).strict(), request.body), admin = requireAdmin(request)
    return { data: await db.transaction(async tx => {
      const [row] = await tx.select().from(users).where(eq(users.id, admin.id)).for('update')
      if (!row || row.twoFactorEnabled || !await verifyPassword(row.passwordHash, password)) throw new ForbiddenError('رمز عبور نامعتبر است یا کلید امنیتی قبلاً فعال شده است.')
      const secret = createTotpSecret(), recoveryCodes = createRecoveryCodes()
      await tx.update(users).set({ totpSecretEncrypted: encryptTotpSecret(secret), recoveryCodesHash: recoveryCodes.map(hashRecoveryCode), updatedAt: new Date() }).where(eq(users.id, admin.id))
      await writeAudit(tx, { actorId: admin.id, action: 'system.mfa_setup_started' })
      return { secret, recoveryCodes }
    }) }
  })
  app.post('/mfa/enable', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async request => {
    const { password, code } = parse(z.object({ password: z.string().min(1).max(1024), code: z.string().regex(/^\d{6}$/) }).strict(), request.body), admin = requireAdmin(request)
    await db.transaction(async tx => {
      const [row] = await tx.select().from(users).where(eq(users.id, admin.id)).for('update')
      if (!row || row.twoFactorEnabled || !row.totpSecretEncrypted || !await verifyPassword(row.passwordHash, password) || !verifyTotp(decryptTotpSecret(row.totpSecretEncrypted), code)) throw new ForbiddenError('رمز عبور یا کد برنامهٔ احراز هویت معتبر نیست.')
      await tx.update(users).set({ twoFactorEnabled: true, updatedAt: new Date() }).where(eq(users.id, admin.id))
      await writeAudit(tx, { actorId: admin.id, action: 'system.mfa_enabled' })
    })
    return { data: { enabled: true } }
  })
  app.post('/authorize', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async request => {
    const input = parse(z.object({ action: actions, payload: z.unknown(), password: z.string().min(1).max(1024), code: z.string().regex(/^\d{6}$/) }).strict(), request.body)
    return { data: await issueAuthorization(db, requireAdmin(request), input.action, input.payload, input.password, input.code) }
  })
  app.get('/gateway', async () => ({ data: await gatewayStatus(db) }))
  app.post('/gateway', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async request => {
    const { proof, ...input } = parse(gatewaySchema.extend({ proof: proofSchema }), request.body)
    return { data: await updateGateway(db, requireAdmin(request), input, proof) }
  })
  app.post('/gateway/diagnose', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async request => {
    const input = parse(confirm, request.body), admin = requireAdmin(request)
    await db.transaction(tx => consumeAuthorization(tx, admin, input.proof, 'gateway.diagnose', { confirm: true }))
    const result = await diagnoseGateway(db)
    await writeAudit(db, { actorId: admin.id, action: 'system.gateway_diagnosed', metadata: { result: result.reachable ? 'reachable' : 'unreachable' } })
    return { data: result }
  })
  app.get('/logs', async request => {
    const input = parse(logsQuery, request.query)
    await writeAudit(db, { actorId: requireAdmin(request).id, action: 'system.logs_viewed', metadata: { operation: 'logs.view' } })
    return { data: await logs(db, input) }
  })
  app.post('/logs/export', async (request, reply) => {
    const { proof, ...input } = parse(logsQuery.extend({ proof: proofSchema }), request.body), admin = requireAdmin(request)
    await db.transaction(tx => consumeAuthorization(tx, admin, proof, 'logs.export', input))
    const data = await logs(db, input, 1000)
    await writeAudit(db, { actorId: admin.id, action: 'system.logs_exported', metadata: { result: 'success' } })
    return reply.header('Content-Disposition', 'attachment; filename="system-events.json"').send(data)
  })
  app.get('/finance/users', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const { search } = parse(z.object({ search: z.string().trim().min(3).max(254) }), request.query)
    const result = await findFinancialUser(db, search)
    await writeAudit(db, { actorId: requireAdmin(request).id, action: 'system.financial_user_searched', metadata: { result: 'success' } })
    return { data: result }
  })
  app.get('/finance/adjustments', async request => {
    const q = parse(paging.extend({ walletId: z.string().uuid().optional() }), request.query)
    const where = q.walletId ? eq(adminAdjustments.walletId, q.walletId) : undefined
    const rows = await db.select({ adjustment: adminAdjustments, ownerEmail: users.email, ownerName: users.firstName, walletName: wallets.name }).from(adminAdjustments)
      .innerJoin(users, eq(adminAdjustments.userId, users.id)).innerJoin(wallets, eq(adminAdjustments.walletId, wallets.id)).where(where).orderBy(desc(adminAdjustments.createdAt)).limit(q.limit).offset((q.page - 1) * q.limit)
    const items = rows.map(({ adjustment, ...owner }) => ({ ...adjustment, ...owner }))
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(adminAdjustments).where(where)
    await writeAudit(db, { actorId: requireAdmin(request).id, action: 'system.adjustments_viewed' })
    return { data: { items, total: count?.n ?? 0, page: q.page, pages: Math.ceil((count?.n ?? 0) / q.limit) } }
  })
  app.post('/finance/adjustments', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async request => {
    const { proof, ...input } = parse(adjustmentSchema.extend({ proof: proofSchema }), request.body)
    const key = parse(z.string().min(8).max(200), request.headers['idempotency-key'])
    return { data: await requestAdjustment(db, requireAdmin(request), input, key, proof) }
  })
  app.post('/finance/adjustments/:id/approve', async request => {
    const { id } = parse(idParam, request.params), { proof } = parse(confirm, request.body)
    return { data: await approveAdjustment(db, requireAdmin(request), id, proof) }
  })
  app.get('/backups', async () => { await initializeBackupJobs(); return { data: (await listBackupJobs()).map(publicJob) } })
  app.get('/backups/:id', async request => ({ data: publicJob(await getBackupJob(parse(idParam, request.params).id)) }))
  app.post('/backups', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { proof } = parse(confirm, request.body)
    return reply.code(202).send({ data: await requestBackupJob(db, requireAdmin(request), 'backup', undefined, proof) })
  })
  app.post('/backups/upload', { bodyLimit: max, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async request => {
    if (!Buffer.isBuffer(request.body)) throw new ForbiddenError('فایل رمزگذاری‌شده را به صورت باینری ارسال کنید.')
    return { data: await importBackup(db, requireAdmin(request), request.body, parse(proofSchema, request.headers['x-system-proof'])) }
  })
  app.post('/backups/:id/rehearse', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = parse(idParam, request.params), { proof } = parse(confirm, request.body)
    return reply.code(202).send({ data: await requestBackupJob(db, requireAdmin(request), 'rehearsal', id, proof) })
  })
  app.post('/backups/:id/download', async (request, reply) => {
    const { id } = parse(idParam, request.params), { proof } = parse(confirm, request.body), admin = requireAdmin(request)
    await db.transaction(async tx => { await consumeAuthorization(tx, admin, proof, 'backup.download', { id, confirm: true }); await writeAudit(tx, { actorId: admin.id, action: 'system.backup_download_requested', targetType: 'system_operation', targetId: id }) })
    const file = await backupFile(id)
    await writeAudit(db, { actorId: admin.id, action: 'system.backup_downloaded', targetType: 'system_operation', targetId: id })
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="parserver-${id}.psb"`).send(createReadStream(file))
  })
  app.post('/backups/:id/delete', async request => {
    const { id } = parse(idParam, request.params), { proof } = parse(confirm, request.body)
    await removeBackup(db, requireAdmin(request), id, proof); return { data: { deleted: true } }
  })
  app.post('/restores', async (request, reply) => {
    const { rehearsalId, proof } = parse(z.object({ rehearsalId: z.string().uuid(), confirm: z.literal('RESTORE DATABASE'), proof: proofSchema }).strict(), request.body)
    return reply.code(202).send({ data: await requestRestore(db, requireAdmin(request), rehearsalId, proof) })
  })
  app.post('/restores/:id/approve', async (request, reply) => {
    const { id } = parse(idParam, request.params), { proof } = parse(z.object({ confirm: z.literal('RESTORE DATABASE'), proof: proofSchema }).strict(), request.body)
    return reply.code(202).send({ data: await approveRestore(db, requireAdmin(request), id, proof) })
  })
}
