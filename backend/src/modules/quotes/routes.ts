import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireUser } from '../../http/auth.js'
import { createQuote, getQuote } from './service.js'
import { rialToToman } from '../../lib/money.js'

const billingOptionSchema = z.object({
  billingCycle: z.string().min(1),
  label: z.string().optional(),
  contractTerm: z.union([z.number(), z.string()]).optional(),
  periodMonths: z.number().int().positive().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  amount: z.string().optional(),
  monthly: z.boolean().optional(),
})

const createQuoteSchema = z.object({
  offerId: z.string().uuid(),
  location: z.string().min(1),
  billingOption: billingOptionSchema,
  operatingSystem: z.string().optional(),
  serviceLevel: z.object({ id: z.string().min(1), label: z.string().optional() }).optional(),
})

export const registerQuoteRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx

  app.post('/quotes', async (request) => {
    const user = requireUser(request)
    const input = parse(createQuoteSchema, request.body)
    const quote = await createQuote(db, {
      userId: user.id,
      offerId: input.offerId,
      locationCode: input.location,
      billingOption: input.billingOption,
      operatingSystem: input.operatingSystem,
      serviceLevel: input.serviceLevel,
    })
    return replyQuote(quote)
  })

  app.get('/quotes/:id', async (request) => {
    const user = requireUser(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const quote = await getQuote(db, user.id, id)
    return replyQuote(quote)
  })
}

function replyQuote(quote: {
  id: string
  provider: string
  providerProductId: string
  providerCurrency: string
  providerAmountCents: number
  fxRate: string
  markupPercent: string
  taxPercent: string
  subtotalRial: number
  taxRial: number
  totalRial: number
  billingInterval: string
  operatingSystem: string | null
  status: string
  expiresAt: Date
}) {
  return {
    data: {
      id: quote.id,
      provider: quote.provider,
      providerProductId: quote.providerProductId,
      providerCurrency: quote.providerCurrency,
      providerAmountCents: quote.providerAmountCents,
      fxRate: quote.fxRate,
      markupPercent: quote.markupPercent,
      taxPercent: quote.taxPercent,
      subtotal: rialToToman(quote.subtotalRial),
      subtotalRial: quote.subtotalRial,
      tax: rialToToman(quote.taxRial),
      taxRial: quote.taxRial,
      total: rialToToman(quote.totalRial),
      totalRial: quote.totalRial,
      billingInterval: quote.billingInterval,
      operatingSystem: quote.operatingSystem,
      status: quote.status,
      expiresAt: quote.expiresAt.toISOString(),
    },
  }
}