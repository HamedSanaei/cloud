import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse, parseIntParam } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { getWallet, listTransactions, listWalletRecords, listWallets } from './service.js'
import { transactionToDto, walletToDto } from '../../lib/dto.js'
import { rialToToman } from '../../lib/money.js'
import { ConflictError } from '../../lib/errors.js'

export const registerWalletRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/wallets', async (request) => {
    const user = requireUser(request)
    const rows = await listWallets(db, user.id)
    return { data: rows.map(walletToDto) }
  })

  app.post('/wallets', async (request) => {
    requireUser(request)
    throw new ConflictError('هر حساب یک کیف پول دارد که خودکار ایجاد می‌شود.')
  })

  app.get('/wallets/summary', async (request) => {
    const user = requireUser(request)
    const wallet = await getWallet(db, user.id)
    return {
      data: {
        totalBalance: rialToToman(wallet.balanceRial),
        totalBalanceRial: wallet.balanceRial,
        wallets: 1,
        defaultWallet: wallet.name,
        connectedProducts: 0,
      },
    }
  })

  app.get('/wallets/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    return { data: walletToDto(await getWallet(db, user.id, id)) }
  })

  app.get('/wallets/:id/transactions', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const active = await getWallet(db, user.id, id)
    const [rows, records] = await Promise.all([listTransactions(db, user.id, { walletId: id === active.id ? undefined : id, limit: query.limit ?? 50 }), listWalletRecords(db, user.id)])
    const names = new Map(records.map(wallet => [wallet.id, wallet.name]))
    return { data: rows.map(row => transactionToDto(row, names.get(row.walletId))) }
  })

  app.get('/wallets/transactions', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const [rows, wallets] = await Promise.all([listTransactions(db, user.id, { limit: query.limit ?? 50 }), listWalletRecords(db, user.id)])
    const names = new Map(wallets.map(wallet => [wallet.id, wallet.name]))
    return { data: rows.map(row => transactionToDto(row, names.get(row.walletId))) }
  })
}

export { parseIntParam }
