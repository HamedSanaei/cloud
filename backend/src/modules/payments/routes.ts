import type { FastifyPluginAsync } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { getConfig } from '../../config.js'
import { requireUser } from '../../http/auth.js'
import { parse } from '../../http/validate.js'
import { ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { isSiteAuthority } from '../integration/authority.js'
import { listWallets } from '../wallets/service.js'
import { walletToDto } from '../../lib/dto.js'
import { authenticCallback, validToken } from './tabapay.js'
import { effectiveGateway } from '../system/gateway.js'
import { createRecharge, paymentDto, verifyRecharge } from './service.js'

export const registerPaymentRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx: { db } }) => {
  app.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer')
    if (!isSiteAuthority()) throw new NotFoundError()
  })
  app.get('/wallets/recharge/options', async request => {
    const user = requireUser(request)
    const gateway = await effectiveGateway(db), enabled = gateway.enabled && validToken(gateway.merchant)
    return { data: { enabled, gateways: enabled ? ['tabapay'] : [], wallets: (await listWallets(db, user.id)).map(walletToDto) } }
  })
  app.post('/wallets/recharges', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async request => {
    const user = requireUser(request)
    const input = parse(z.object({ walletId: z.string().uuid(), amountToman: z.number().int().min(10000).max(50000000) }).strict(), request.body)
    const key = parse(z.string().min(8).max(200), request.headers['idempotency-key'])
    return { data: await createRecharge(db, user.id, input.walletId, input.amountToman * 10, key) }
  })
  const ownedPayment = async (id: string, userId: string) => {
    const payment = await db.query.walletPayments.findFirst({ where: t => eq(t.id, id) })
    if (!payment || payment.userId !== userId) throw new NotFoundError('پرداخت یافت نشد.')
    return payment
  }
  app.get('/wallets/recharges/:id', async request => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    return { data: paymentDto(await ownedPayment(id, user.id)) }
  })
  app.post('/wallets/recharges/:id/verify', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    await ownedPayment(id, user.id)
    return { data: await verifyRecharge(db, id) }
  })
  app.route({ method: ['GET', 'POST'], url: '/payments/tabapay/callback', bodyLimit: 8192,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, handler: async (request, reply) => {
      const post = request.method === 'POST'
      const { token } = parse(z.object({ token: z.string().uuid() }), post ? request.body : request.query)
      const payment = await db.query.walletPayments.findFirst({ where: t => eq(t.gatewayToken, token.toLowerCase()) })
      if (post && (!payment || !authenticCallback(request.headers.authorize ?? request.headers.http_authorize, (await effectiveGateway(db, payment.merchantFingerprint)).merchant))) throw new ForbiddenError()
      if (!payment) throw new NotFoundError('درخواست پرداخت یافت نشد.')
      try {
        const result = await verifyRecharge(db, payment.id)
        if (post) return reply.code(result.status === 'succeeded' ? 200 : 202).send({ status: result.status === 'succeeded' ? 'success' : 'pending' })
      } catch {
        if (post) return reply.code(503).send({ status: 'pending' })
      }
      return reply.redirect(new URL(`/wallet?payment=${payment.id}`, getConfig().FRONTEND_URL).href)
    } })
}
