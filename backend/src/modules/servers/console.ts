import type { FastifyPluginAsync } from 'fastify'
import WebSocket, { type RawData } from 'ws'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { serverSecrets } from '../../db/schema.js'
import { getConfig } from '../../config.js'
import { parse } from '../../http/validate.js'
import { AUTH_COOKIE, requireUser } from '../../http/auth.js'
import { ConflictError, ForbiddenError } from '../../lib/errors.js'
import { authenticateToken } from '../auth/service.js'
import { writeAudit } from '../audit/service.js'
import { customerProvider } from './management.js'
import { decryptOutput, encryptOutput } from './secrets.js'
import { getServerForUser } from './service.js'
import { connectConsole } from './console-transport.js'
import { maintenanceActive, releaseRequestWriter } from '../system/writer-gate.js'

const params = z.object({ id: z.string().uuid(), grantId: z.string().uuid() })
function permittedUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.hetzner.cloud') || url.username || url.password || url.port && url.port !== '443') throw new ForbiddenError('مبدأ کنسول مجاز نیست')
  return value
}
export const registerServerConsole: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  app.post('/servers/:id/console', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireUser(request), { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    if (!request.cookies[AUTH_COOKIE]) throw new ForbiddenError('کنسول به نشست امن مرورگر نیاز دارد')
    const server = await getServerForUser(ctx.db, user.id, id)
    if (server.terminatedAt || server.terminationState && server.terminationState !== 'delete_failed') throw new ConflictError('سرور در دسترس نیست یا حذف آن در جریان است')
    const console = await customerProvider(server).console(server.providerServerId!)
    const [grant] = await ctx.db.insert(serverSecrets).values({ serverId: id, userId: user.id, sessionId: user.sessionId, kind: 'console',
      encrypted: encryptOutput(permittedUrl(console.url), `${user.id}:${id}:${user.sessionId}:console`), expiresAt: new Date(Date.now() + 90000) }).returning({ id: serverSecrets.id, expiresAt: serverSecrets.expiresAt })
    await writeAudit(ctx.db, { actorId: user.id, action: 'server.console.created', targetType: 'server', targetId: id })
    reply.header('Cache-Control', 'no-store'); reply.header('Pragma', 'no-cache')
    return { data: { grantId: grant!.id, expiresAt: grant!.expiresAt.toISOString(), password: console.password, maxSessionSeconds: 300 } }
  })
  app.get('/servers/:id/console/:grantId', { websocket: true, preHandler: async request => {
    const user = requireUser(request), origin = request.headers.origin, host = request.headers.host
    const allowed = getConfig().CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean)
    if (!request.cookies[AUTH_COOKIE] || !origin || (!allowed.includes(origin) && origin !== `https://${host}` && origin !== `http://${host}`)) throw new ForbiddenError('مبدأ یا نشست کنسول معتبر نیست')
    const { id, grantId } = parse(params, request.params), server = await getServerForUser(ctx.db, user.id, id)
    if (server.terminatedAt || server.terminationState && server.terminationState !== 'delete_failed') throw new ConflictError('سرور در دسترس نیست')
    const grant = await ctx.db.query.serverSecrets.findFirst({ where: t => and(eq(t.id, grantId), eq(t.serverId, id), eq(t.userId, user.id), eq(t.sessionId, user.sessionId), eq(t.kind, 'console'), isNull(t.claimedAt), gt(t.expiresAt, new Date())) })
    if (!grant?.encrypted) throw new ForbiddenError('نشست کنسول منقضی یا مصرف شده است')
  } }, (socket, request) => {
    let upstream: WebSocket | undefined, closed = false, buffered = 0
    const pending: Array<{ data: RawData; binary: boolean }> = []
    const finish = () => { if (closed) return; closed = true; clearTimeout(deadline); clearInterval(authCheck); socket.close(1000); upstream?.close(1000); pending.length = 0 }
    const deadline = setTimeout(finish, 300000)
    const authCheck = setInterval(() => {
      void (async () => {
        if (await maintenanceActive()) { finish(); return }
        const user = await authenticateToken(ctx.db, request.cookies[AUTH_COOKIE])
        if (!user || user.sessionId !== request.user?.sessionId) { finish(); return }
        const { id } = parse(params, request.params), server = await getServerForUser(ctx.db, user.id, id)
        if (server.terminatedAt) finish()
      })().catch(finish)
    }, 30000)
    socket.on('close', finish); socket.on('error', finish)
    socket.on('message', (data, binary) => {
      if (closed) return
      if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 2 * 1024 * 1024) { finish(); return }
        upstream.send(data, { binary })
      } else {
        buffered += Buffer.isBuffer(data) ? data.byteLength : data instanceof ArrayBuffer ? data.byteLength : data.reduce((n, b) => n + b.byteLength, 0)
        if (buffered > 1024 * 1024) { finish(); return }
        pending.push({ data, binary })
      }
    })
    void (async () => {
      const user = requireUser(request), { id, grantId } = parse(params, request.params)
      const value = await ctx.db.transaction(async tx => {
        const [grant] = await tx.select().from(serverSecrets).where(and(eq(serverSecrets.id, grantId), eq(serverSecrets.serverId, id), eq(serverSecrets.userId, user.id), eq(serverSecrets.sessionId, user.sessionId), isNull(serverSecrets.claimedAt), gt(serverSecrets.expiresAt, new Date()))).for('update')
        if (!grant?.encrypted || closed) throw new ForbiddenError('کنسول قابل اتصال نیست')
        const url = permittedUrl(decryptOutput(grant.encrypted, `${user.id}:${id}:${user.sessionId}:console`))
        await tx.update(serverSecrets).set({ encrypted: null, claimedAt: new Date() }).where(eq(serverSecrets.id, grantId))
        return url
      })
      if (closed) return
      upstream = connectConsole(value)
      upstream.on('error', finish); upstream.on('close', finish)
      upstream.on('open', () => { for (const frame of pending) upstream!.send(frame.data, { binary: frame.binary }); pending.length = 0; buffered = 0 })
      upstream.on('message', (data, binary) => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 2 * 1024 * 1024) socket.send(data, { binary }); else finish() })
    })().catch(finish).finally(() => releaseRequestWriter(request))
  })
}
