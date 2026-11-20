import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { customerInvoiceStatuses, getInvoice, listInvoices } from './service.js'
import { invoiceToDto } from '../../lib/dto.js'
import { historyPage, historyQuery } from '../../lib/list-search.js'

const invoiceQuery = historyQuery.extend({ status: z.enum(customerInvoiceStatuses).default('all') })

export const registerInvoiceRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/invoices', async (request) => {
    const user = requireUser(request)
    const query = parse(invoiceQuery, request.query)
    const now = new Date()
    const rows = await listInvoices(db, user.id, { ...query, limit: query.limit + 1, now })
    return historyPage(rows.map(row => invoiceToDto(row, now)), query.limit, query.offset)
  })

  app.get('/invoices/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const invoice = await getInvoice(db, user.id, id)
    return {
      data: {
        ...invoiceToDto(invoice),
        items: invoice.items.map((i) => ({
          id: i.id,
          description: i.description,
          quantity: i.quantity,
          totalRial: i.totalRial,
        })),
      },
    }
  })
}
