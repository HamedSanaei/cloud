import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../../app.js'
import { parse } from '../../http/validate.js'
import { requireAdmin } from '../../http/auth.js'
import { listAudit, writeAudit } from '../audit/service.js'
import { creditWallet, debitWallet, listWallets } from '../wallets/service.js'
import { listFxRateHistory, setFxRate, getPricingRules, updatePricingRules } from '../pricing/service.js'
import { listOffers, listSyncRuns, setLocationAvailability, setOfferEnabled, syncProviderCatalog } from '../catalog/service.js'
import { getProvider } from '../providers/registry.js'
import { orders, providerProducts, providerOperations } from '../../db/schema.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { rialToToman } from '../../lib/money.js'
import { resolveOperationByAdmin } from '../provisioning/handlers.js'

const amountSchema = z.object({ amountRial: z.number().int().positive(), note: z.string().max(300).optional() })

export const registerAdminRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, queues } = ctx

  app.get('/admin/users', async (request) => {
    requireAdmin(request)
    const rows = await db.query.users.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 100 })
    const withWallets = await Promise.all(
      rows.map(async (u) => {
        const wallets = await listWallets(db, u.id)
        return {
          id: u.id,
          email: u.email,
          role: u.role,
          status: u.status,
          createdAt: u.createdAt.toISOString(),
          wallets: wallets.map((w) => ({ id: w.id, name: w.name, balanceRial: w.balanceRial, isDefault: w.isDefault })),
        }
      }),
    )
    return { data: withWallets }
  })

  app.post('/admin/wallets/:walletId/credit', async (request) => {
    const admin = requireAdmin(request)
    const { walletId } = parse(z.object({ walletId: z.string().uuid() }), request.params)
    const input = parse(amountSchema, request.body)
    const wallet = await db.query.wallets.findFirst({ where: (t) => eq(t.id, walletId) })
    if (!wallet) throw new NotFoundError('کیف پول یافت نشد')
    await creditWallet(db, wallet.userId, walletId, input.amountRial, {
      type: 'manual_credit',
      idempotencyKey: `admin-credit:${admin.sessionId}:${Date.now()}`,
      description: input.note ?? 'اعتبار دستی توسط مدیر',
      metadata: { adminId: admin.id },
    })
    return { data: { ok: true } }
  })

  app.post('/admin/wallets/:walletId/debit', async (request) => {
    const admin = requireAdmin(request)
    const { walletId } = parse(z.object({ walletId: z.string().uuid() }), request.params)
    const input = parse(amountSchema, request.body)
    const wallet = await db.query.wallets.findFirst({ where: (t) => eq(t.id, walletId) })
    if (!wallet) throw new NotFoundError('کیف پول یافت نشد')
    await debitWallet(db, wallet.userId, walletId, input.amountRial, {
      type: 'manual_debit',
      idempotencyKey: `admin-debit:${admin.sessionId}:${Date.now()}`,
      description: input.note ?? 'برداشت دستی توسط مدیر',
      metadata: { adminId: admin.id },
    })
    return { data: { ok: true } }
  })

  app.get('/admin/fx-rates', async (request) => {
    requireAdmin(request)
    const query = parse(z.object({ currency: z.string().regex(/^[A-Z]{3}$/).default('EUR') }), request.query)
    return { data: await listFxRateHistory(db, 20, query.currency) }
  })

  app.post('/admin/fx-rates', async (request) => {
    const admin = requireAdmin(request)
    const input = parse(z.object({ rate: z.string().min(1), currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'), note: z.string().max(300).optional() }), request.body)
    const row = await setFxRate(db, input.rate, { actorId: admin.id, note: input.note, currency: input.currency })
    return { data: { id: row.id, currency: row.fromCurrency, rate: row.rate, createdAt: row.createdAt } }
  })

  app.get('/admin/pricing', async (request) => {
    requireAdmin(request)
    const query = parse(z.object({ provider: z.string().default('leaseweb') }), request.query)
    const rules = await getPricingRules(db, query.provider)
    return { data: { ...rules, markupPercent: Number(rules.markupPercent), taxPercent: Number(rules.taxPercent) } }
  })

  app.put('/admin/pricing', async (request) => {
    const admin = requireAdmin(request)
    const input = parse(
      z.object({
        provider: z.string().default('leaseweb'),
        markupPercent: z.number().min(0).max(1000).optional(),
        markupFixedRial: z.number().int().min(0).optional(),
        taxPercent: z.number().min(0).max(100).optional(),
        roundingToRial: z.number().int().min(1).optional(),
        enabled: z.boolean().optional(),
      }),
      request.body,
    )
    const rules = await updatePricingRules(db, input.provider, input, admin.id)
    return { data: { ...rules, markupPercent: Number(rules.markupPercent), taxPercent: Number(rules.taxPercent) } }
  })

  app.post('/admin/providers/:providerId/catalog/sync', async (request) => {
    const admin = requireAdmin(request)
    const { providerId } = parse(z.object({ providerId: z.string() }), request.params)
    const provider = getProvider(providerId)
    // Run inline for admin UX; also queued to keep catalog fresh.
    const result = await syncProviderCatalog(db, provider, { actorId: admin.id })
    await queues.addCatalogSync(providerId, admin.id)
    return { data: result }
  })

  app.get('/admin/offers', async (request) => {
    requireAdmin(request)
    const rows = await listOffers(db, { provider: 'leaseweb', enabledOnly: false })
    return { data: rows.map((r) => ({ id: r.id, providerProductId: r.providerProductId, name: r.name, locationId: r.locationId, vcpu: r.vcpu, memoryMb: r.memoryMb, diskGb: r.diskGb, available: r.available, enabled: r.enabled, providerPriceCents: r.providerPriceCents, providerCurrency: r.providerCurrency })) }
  })

  app.patch('/admin/offers/:id', async (request) => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const input = parse(z.object({ enabled: z.boolean().optional(), available: z.boolean().optional() }), request.body)
    if (input.enabled !== undefined) await setOfferEnabled(db, id, input.enabled, admin.id)
    if (input.available !== undefined) {
      await db.update(providerProducts).set({ available: input.available }).where(eq(providerProducts.id, id))
    }
    return { data: { ok: true } }
  })

  app.get('/admin/locations', async (request) => {
    requireAdmin(request)
    const query = parse(z.object({ provider: z.string().default('leaseweb') }), request.query)
    const all = await db.query.providerLocations.findMany({ where: (t) => eq(t.provider, query.provider) })
    return { data: all.map((l) => ({ id: l.id, code: l.code, country: l.country, city: l.city, available: l.available })) }
  })

  app.patch('/admin/locations/:code', async (request) => {
    const admin = requireAdmin(request)
    const { code } = parse(z.object({ code: z.string().min(1) }), request.params)
    const input = parse(z.object({ available: z.boolean() }), request.body)
    await setLocationAvailability(db, 'leaseweb', code, input.available, admin.id)
    return { data: { ok: true } }
  })

  app.get('/admin/provider-operations', async (request) => {
    requireAdmin(request)
    const query = parse(z.object({ status: z.string().optional(), limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    const rows = await db.query.providerOperations.findMany({
      where: (t, { and, eq: e }) => (query.status ? and(e(t.status, query.status as never)) : undefined),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: query.limit ?? 50,
    })
    return { data: rows }
  })

  /**
   * MANUAL reconciliation — mark this operation MATCHED to an explicit
   * provider server id supplied by the operator. Completes the order
   * deterministically. Audited. Never accepts "a candidate" without an id.
   */
  app.post('/admin/provider-operations/:id/mark-match', async (request) => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const input = parse(z.object({ providerServerId: z.string().min(1).max(200), note: z.string().max(500).optional() }), request.body)
    await resolveOperationByAdmin(db, id, {
      actorId: admin.id,
      action: 'mark-match',
      providerServerId: input.providerServerId,
      note: input.note,
    })
    return { data: { ok: true } }
  })

  /** Manual reconciliation — mark the operation rejected (no server). */
  app.post('/admin/provider-operations/:id/mark-rejected', async (request) => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const input = parse(z.object({ note: z.string().max(500).optional() }), request.body)
    await resolveOperationByAdmin(db, id, { actorId: admin.id, action: 'mark-rejected', note: input.note })
    return { data: { ok: true } }
  })

  /** Manual reconciliation — reopen ONLY a proven-failed operation for retry. */
  app.post('/admin/provider-operations/:id/reopen-for-retry', async (request) => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const body = parse(z.object({ note: z.string().max(500).optional() }), request.body)
    const op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, id) })
    if (!op) throw new NotFoundError('عملیات سرویس‌دهنده یافت نشد')
    // NEVER reopen UNKNOWN operations: the provider may have processed the
    // original POST — a retry could create a second paid server.
    if (op.status === 'unknown') {
      throw new ConflictError('عملیات با نتیجه نامشخص (UNKNOWN) قابل بازگشایی برای ارسال مجدد نیست — ابتدا به‌صورت دستی تعیین تکلیف کنید')
    }
    const meta = (op.responseMetadata ?? {}) as Record<string, unknown>
    if (op.status === 'failed' && meta.permanent === true) {
      throw new ConflictError('این عملیات به‌صورت قطعی رد شده است (permanent) و قابل ارسال مجدد نیست')
    }
    await db.update(providerOperations).set({ status: 'pending', lastError: null, updatedAt: new Date() }).where(eq(providerOperations.id, id))
    const order = op.referenceType === 'order' ? await db.query.orders.findFirst({ where: (t) => eq(t.id, op.referenceId) }) : null
    if (order && order.status === 'failed') {
      await db.update(orders).set({ status: 'queued', error: null, updatedAt: new Date() }).where(eq(orders.id, order.id))
    }
    if (op.kind === 'provision') {
      await queues.addProvision(op.referenceId)
    }
    await writeAudit(db, {
      actorId: admin.id,
      action: 'admin.provider_operation_reopened',
      targetType: 'provider_operation',
      targetId: op.id,
      metadata: { note: body.note ?? null },
    })
    return { data: { ok: true } }
  })

  app.post('/admin/provider-operations/:id/reconcile', async (request) => {
    requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    await queues.addReconcile(id)
    return { data: { ok: true, queued: true } }
  })

  app.post('/admin/provider-operations/:id/retry', async (request) => {
    const admin = requireAdmin(request)
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params)
    const op = await db.query.providerOperations.findFirst({ where: (t) => eq(t.id, id) })
    if (!op) throw new NotFoundError('عملیات سرویس‌دهنده یافت نشد')
    if (op.status === 'succeeded') return { data: { ok: true, skipped: true } }
    // NEVER retry an operation with an ambiguous outcome.
    if (op.status === 'unknown') {
      throw new ConflictError('عملیات با نتیجه نامشخص (UNKNOWN) قابل ارسال مجدد نیست — ابتدا تعیین تکلیف دستی انجام دهید')
    }
    if (op.kind === 'provision') {
      await db.update(providerOperations).set({ status: 'pending', lastError: null, updatedAt: new Date() }).where(eq(providerOperations.id, id))
      const order = await db.query.orders.findFirst({ where: (t) => eq(t.id, op.referenceId) })
      if (order && order.status === 'failed') {
        await db.update(orders).set({ status: 'queued', error: null, updatedAt: new Date() }).where(eq(orders.id, order.id))
      }
      await queues.addProvision(op.referenceId)
    } else if (op.kind === 'server_action') {
      await db.update(providerOperations).set({ status: 'pending', lastError: null, updatedAt: new Date() }).where(eq(providerOperations.id, id))
      await queues.addServerAction({ operationId: op.id, serverId: op.referenceId, action: (op.action as 'power_on' | 'power_off' | 'reboot') ?? 'reboot' })
    }
    await writeAudit(db, { actorId: admin.id, action: 'admin.provider_operation_retried', targetType: 'provider_operation', targetId: op.id })
    return { data: { ok: true } }
  })

  app.get('/admin/sync-runs', async (request) => {
    requireAdmin(request)
    return { data: await listSyncRuns(db, 'leaseweb') }
  })

  app.get('/admin/orders', async (request) => {
    requireAdmin(request)
    const rows = await db.query.orders.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 100 })
    return { data: rows.map((o) => ({ id: o.id, orderNumber: o.orderNumber, userId: o.userId, status: o.status, totalRial: o.totalRial, totalToman: rialToToman(o.totalRial), providerProductId: o.providerProductId, providerLocation: o.providerLocation, hostname: o.hostname, createdAt: o.createdAt.toISOString(), error: o.error })) }
  })

  app.get('/admin/invoices', async (request) => {
    requireAdmin(request)
    const rows = await db.query.invoices.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 100 })
    return { data: rows.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, userId: i.userId, status: i.status, totalRial: i.totalRial, issuedAt: i.issuedAt.toISOString(), paidAt: i.paidAt?.toISOString() ?? null })) }
  })

  app.get('/admin/audit', async (request) => {
    requireAdmin(request)
    const query = parse(z.object({ action: z.string().optional(), limit: z.coerce.number().int().positive().max(200).optional() }), request.query)
    return { data: await listAudit(db, { action: query.action, limit: query.limit ?? 50 }) }
  })
}