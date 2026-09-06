import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { getInvoice, listInvoices } from './service.js'
import { invoiceToDto } from '../../lib/dto.js'

export const registerInvoiceRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.get('/invoices', async (request) => {
    const user = requireUser(request)
    const query = parse(z.object({ limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await listInvoices(db, user.id, { limit: query.limit ?? 50 })
    return { data: rows.map(invoiceToDto) }
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