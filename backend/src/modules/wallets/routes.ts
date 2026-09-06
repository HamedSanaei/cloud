import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse, parseIntParam } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { createWallet, listTransactions, listWallets, totalBalanceRial } from './service.js'
import { transactionToDto, walletToDto } from '../../lib/dto.js'
import { rialToToman } from '../../lib/money.js'
import { NotFoundError } from '../../lib/errors.js'

const createWalletSchema = z.object({
  name: z.string().min(1, 'نام کیف پول الزامی است').max(100),
  description: z.string().max(300).optional(),
  isDefault: z.boolean().optional(),
})

export const registerWalletRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/wallets', async (request) => {
    const user = requireUser(request)
    const rows = await listWallets(db, user.id)
    return { data: rows.map(walletToDto) }
  })

  app.post('/wallets', async (request) => {
    const user = requireUser(request)
    const input = parse(createWalletSchema, request.body)
    const wallet = await createWallet(db, user.id, input)
    return { data: walletToDto(wallet) }
  })

  app.get('/wallets/summary', async (request) => {
    const user = requireUser(request)
    const rows = await listWallets(db, user.id)
    const total = await totalBalanceRial(db, user.id)
    const defaultWallet = rows.find((w) => w.isDefault) ?? rows[0]
    return {
      data: {
        totalBalance: rialToToman(total),
        totalBalanceRial: total,
        wallets: rows.length,
        defaultWallet: defaultWallet?.name ?? 'پیش‌فرض',
        connectedProducts: 0,
      },
    }
  })

  app.get('/wallets/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const rows = await listWallets(db, user.id)
    const wallet = rows.find((w) => w.id === id)
    if (!wallet) throw new NotFoundError('کیف پول یافت نشد')
    return { data: walletToDto(wallet) }
  })

  app.get('/wallets/:id/transactions', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listTransactions(db, user.id, { walletId: id, limit: query.limit ?? 50 })
    return { data: rows.map(transactionToDto) }
  })

  app.get('/wallets/transactions', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listTransactions(db, user.id, { limit: query.limit ?? 50 })
    return { data: rows.map(transactionToDto) }
  })
}

export { parseIntParam }