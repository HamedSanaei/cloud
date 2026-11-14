import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../../app.js'
import { idempotencyKeys, serverSecrets } from '../../db/schema.js'
import { parse } from '../../http/validate.js'
import { hasBrowserSession, requireUser } from '../../http/auth.js'
import { ConflictError, NotFoundError, ProviderPermanentError, ProviderRetryableError, ProviderUnknownError, ValidationError } from '../../lib/errors.js'
import { serverToDto } from '../../lib/dto.js'
import { loadFundingFleet, serverPowerPolicy } from '../billing/funding.js'
import { createQuote } from '../quotes/service.js'
import { retailBilling, type RetailPeriod } from '../pricing/periods.js'
import type { ProviderBillingOption, ProviderServerView } from '../providers/provider.interface.js'
import type { CustomerProvider, ServerAccessBlock, ServerAccessEligibility } from '../providers/customer.interface.js'
import { HetznerApiError } from '../providers/hetzner/client.js'
import { customerProvider, findBlockingManagementOperation, isOrphanedPowerOperation, managementBlock, managementConflict, managementDto, reconcileCustomerOperation, requestManagement } from './management.js'
import { inspectLegacyPowerOperation, reconcileReceiptlessPowerOffWithoutProviderAction } from './power-reconciliation.js'
import { getServerForUser } from './service.js'
import { claimServerPassword } from './secrets.js'

const params = z.object({ id: z.string().uuid() })
const acknowledgement = { confirm: z.literal(true), hostname: z.string().min(1).max(63) }
const numericId = z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)))
const actionInput = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['power_on', 'shutdown', 'power_off', 'reboot', 'reset', 'delete', 'reset_password', 'enable_rescue', 'disable_rescue', 'detach_iso']), ...acknowledgement }).strict(),
  z.object({ action: z.literal('resize'), quoteId: z.string().uuid(), upgradeDisk: z.boolean(), ...acknowledgement }).strict(),
  z.object({ action: z.literal('rebuild'), image: numericId, ...acknowledgement }).strict(),
  z.object({ action: z.literal('attach_iso'), iso: numericId, ...acknowledgement }).strict(),
  z.object({ action: z.literal('change_protection'), delete: z.boolean(), rebuild: z.boolean(), ...acknowledgement }).strict(),
])
const cache = new Map<string, { expiresAt: number; value: Promise<ProviderServerView> }>()
async function liveView(server: Awaited<ReturnType<typeof getServerForUser>>, manager: CustomerProvider, fresh: boolean) {
  const key = `${server.id}:${server.providerServerId}:${server.status}`, prior = cache.get(key)
  if (!fresh && prior && prior.expiresAt > Date.now()) return prior.value
  if (cache.size >= 200) cache.delete(cache.keys().next().value!)
  const value = manager.inspect(server.providerServerId!)
  cache.set(key, { value, expiresAt: Date.now() + 15000 })
  try { return await value } catch (error) { if (cache.get(key)?.value === value) cache.delete(key); throw error }
}
const metricCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>()
export const registerCustomerServerRoutes: FastifyPluginAsync<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, queues } = ctx
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  app.get('/servers/:id/management', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const user = requireUser(request), { id } = parse(params, request.params), server = await getServerForUser(db, user.id, id)
    const { refresh } = parse(z.object({ refresh: z.literal('1').optional() }), request.query)
    let manager: CustomerProvider | undefined
    let providerBlock: ServerAccessBlock | null = null
    try { manager = customerProvider(server) } catch (error) {
      if (error instanceof ConflictError) providerBlock = 'provider_access_denied'
      else if (error instanceof NotFoundError || error instanceof ValidationError) providerBlock = 'unsupported'
      else throw error
    }
    let view: ProviderServerView | null = null
    if (manager && !server.terminatedAt && server.status !== 'terminated') {
      try { view = await liveView(server, manager, refresh === '1') } catch (error) {
        const accessDenied = error instanceof HetznerApiError ? [401, 403, 404].includes(error.httpStatus) : error instanceof ProviderPermanentError
        providerBlock = accessDenied ? 'provider_access_denied' : 'provider_unavailable'
      }
    }
    const meta = view?.metadata ?? {}, order = await db.query.orders.findFirst({ where: t => eq(t.id, server.orderId) })
    const [subscription, quote, history, blockingOperation] = await Promise.all([
      server.subscriptionId ? db.query.subscriptions.findFirst({ where: t => and(eq(t.id, server.subscriptionId!), eq(t.userId, user.id)) }) : undefined,
      order?.quoteId ? db.query.quotes.findFirst({ where: t => and(eq(t.id, order.quoteId!), eq(t.userId, user.id)) }) : undefined,
      db.query.providerOperations.findMany({ where: t => and(eq(t.referenceId, server.id), inArray(t.kind, ['server_action', 'server_management'])), orderBy: t => desc(t.createdAt), limit: 30 }),
      findBlockingManagementOperation(db, server.id),
    ])
    const operations = blockingOperation && !history.some(op => op.id === blockingOperation.id) ? [...history, blockingOperation] : history
    const commonBlock = managementBlock(server, !!blockingOperation) ?? providerBlock
    const protection = meta.protection as { rebuild?: boolean } | undefined
    const accessEligibility: ServerAccessEligibility = {
      rebuild: commonBlock ?? (protection?.rebuild === true ? 'rebuild_protected' : null),
      resetPassword: commonBlock,
    }
    const credentials = await db.query.serverSecrets.findMany({ where: t => and(eq(t.serverId, id), eq(t.userId, user.id), eq(t.sessionId, user.sessionId), gt(t.expiresAt, new Date())), columns: { operationId: true, claimedAt: true, acknowledgedAt: true } })
    const fleet = await loadFundingFleet(db, user.id)
    return { data: { ...serverToDto(server, serverPowerPolicy(server, fleet)), lifecycle: server.terminationState ?? (server.activatedAt ? 'ready' : 'provisioning'),
      providerAvailable: !!view, providerIdentity: server.providerServerId, providerState: view?.state ?? (server.terminatedAt ? 'terminated' : null),
      facts: view ? { hostname: view.hostname ?? null, vcpu: view.vcpu ?? null, memoryMb: view.memoryMb ?? null, diskGb: view.diskGb ?? null,
        ipv4: view.ipv4 ?? null, ipv6: view.ipv6 ?? null, createdAt: meta.createdAt ?? null, location: meta.location ?? null, serverType: meta.serverType ?? null,
        image: meta.operatingSystem ?? null, imageId: meta.imageId ?? null, outgoingTrafficBytes: meta.outgoingTrafficBytes ?? null, includedTrafficBytes: meta.includedTrafficBytes ?? null,
        trafficPeriod: null, protection: meta.protection ?? null, rescueEnabled: meta.rescueEnabled ?? null, isoId: meta.isoId ?? null,
        backupWindow: meta.backupWindow ?? null, volumes: meta.volumes ?? [], privateNetworks: meta.privateNetworks ?? [], firewalls: meta.firewalls ?? [], floatingIps: meta.floatingIps ?? [] } : null,
      billing: { subscriptionId: subscription?.id ?? null, state: subscription?.status ?? null, period: subscription?.billingInterval ?? order?.billingInterval ?? null,
        customerPriceRial: subscription?.priceRial ?? order?.totalRial ?? null, nextInvoiceAt: subscription?.nextInvoiceAt.toISOString() ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd.toISOString() ?? null, autoRenew: subscription?.autoRenew ?? false,
        futureDebits: server.terminatedAt ? 'stopped' : server.terminationState && server.terminationState !== 'delete_failed' ? 'held_pending_confirmation' : 'normal',
        refundPolicy: 'no_automatic_proration', providerQuotedRate: quote ? { currency: quote.providerCurrency, amountCents: quote.providerAmountCents, period: quote.billingInterval, observedAt: quote.createdAt.toISOString() } : null },
      capabilities: { power: !!manager, resize: !!manager, rebuild: !!manager, resetPassword: !!manager, console: !!manager?.console, rescue: !!manager, protection: !!manager,
        iso: false, snapshots: false, backups: false, volumes: false, networkMutations: false,
        unavailableReason: 'مالکیت و تعرفهٔ مستقل منابع جانبی باید پیش از فعال‌سازی عملیات در فروشگاه ثبت شود؛ فهرست منابع متصل صرفاً جهت اطلاع است.' },
      accessEligibility, resizeBlock: commonBlock,
      consoleBlock: commonBlock ?? (hasBrowserSession(request) ? null : 'browser_session_required'),
      operations: operations.map(managementDto), credentials,
    } }
  })
  app.post('/servers/:id/management/operations/:operationId/recheck', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = requireUser(request)
    const { id, operationId } = parse(params.extend({ operationId: z.string().uuid() }), request.params)
    const server = await getServerForUser(db, user.id, id)
    const findOperation = () => db.query.providerOperations.findFirst({ where: t => and(eq(t.id, operationId),
      eq(t.referenceId, server.id), eq(t.referenceType, 'server'), inArray(t.kind, ['server_management', 'server_action'])) })
    const operation = await findOperation()
    if (!operation) throw new NotFoundError('عملیات سرور یافت نشد')
    let checkFailed = false
    try {
      if (isOrphanedPowerOperation(operation)) {
        // Never release this lock by timeout alone; require full provider proof.
        const recovered = await reconcileReceiptlessPowerOffWithoutProviderAction(db, server, operation, user.id)
        if (!recovered) await inspectLegacyPowerOperation(server, operation)
      } else await reconcileCustomerOperation(db, server, operation)
    } catch (error) {
      if (!(error instanceof ProviderPermanentError || error instanceof ProviderRetryableError || error instanceof ProviderUnknownError)) throw error
      checkFailed = true
    }
    const current = await findOperation()
    if (!current) throw new NotFoundError('عملیات سرور یافت نشد')
    return { data: { operation: managementDto(current), checkFailed } }
  })
  app.get('/servers/:id/images', async request => {
    const user = requireUser(request), { id } = parse(params, request.params), server = await getServerForUser(db, user.id, id)
    return { data: await customerProvider(server).images(server.providerServerId!) }
  })
  app.get('/servers/:id/resize-options', async request => {
    const user = requireUser(request), { id } = parse(params, request.params), server = await getServerForUser(db, user.id, id)
    const manager = customerProvider(server)
    const view = await liveView(server, manager, false)
    const options = (await manager.resizeOptions(server.providerServerId!)).filter(option => option.available &&
      option.type !== view.metadata?.serverType && option.diskGb >= (view.diskGb ?? Infinity) && option.storageType === view.metadata?.storageType)
    const offers = await db.query.providerProducts.findMany({ where: t => and(eq(t.provider, server.provider), eq(t.enabled, true), eq(t.available, true)) })
    const locations = await db.query.providerLocations.findMany()
    return { data: options.flatMap(option => {
      const offer = offers.find(offer => offer.providerProductId.split(':')[0] === option.type && locations.some(location => location.id === offer.locationId && location.code === server.providerLocation))
      return offer ? [{ ...option, offerId: offer.id }] : []
    }) }
  })
  app.post('/servers/:id/resize-preview', async request => {
    const user = requireUser(request), { id } = parse(params, request.params), server = await getServerForUser(db, user.id, id)
    const input = parse(z.object({ offerId: z.string().uuid(), upgradeDisk: z.boolean() }).strict(), request.body)
    const block = managementBlock(server, !!await findBlockingManagementOperation(db, server.id))
    if (block) throw new ConflictError(managementConflict[block])
    const manager = customerProvider(server), view = await manager.inspect(server.providerServerId!)
    if (view.state !== 'suspended') throw new ValidationError('ارائه‌دهنده هنوز خاموش بودن سرور را تأیید نکرده است')
    const options = await manager.resizeOptions(server.providerServerId!)
    const offer = await db.query.providerProducts.findFirst({ where: t => eq(t.id, input.offerId) })
    const location = offer?.locationId ? await db.query.providerLocations.findFirst({ where: t => eq(t.id, offer.locationId!) }) : null
    const target = options.find(option => option.type === offer?.providerProductId.split(':')[0])
    if (!offer || !offer.enabled || !offer.available || offer.provider !== 'hetzner' || location?.code !== server.providerLocation || !target?.available || target.type === view.metadata?.serverType || target.diskGb < (view.diskGb ?? Infinity) || target.storageType !== view.metadata?.storageType) throw new ValidationError('پلن مقصد یا وضعیت سرور برای تغییر مجاز نیست')
    const sub = server.subscriptionId ? await db.query.subscriptions.findFirst({ where: t => eq(t.id, server.subscriptionId!) }) : null
    const period = sub?.billingInterval.toLowerCase() as RetailPeriod | undefined
    if (!period || !['hourly', 'daily', 'monthly'].includes(period)) throw new ValidationError('دورهٔ صورتحساب برای تغییر پلن پشتیبانی نمی‌شود')
    const quote = await createQuote(db, { userId: user.id, offerId: offer.id, locationCode: server.providerLocation,
      billingOption: retailBilling(offer.billingOptions as ProviderBillingOption[], period).native, billingPeriod: period })
    const baseline = { serverType: view.metadata?.serverType, diskGb: view.diskGb, imageId: view.metadata?.imageId }
    const payload = { serverType: target.type, upgradeDisk: input.upgradeDisk, priceRial: quote.totalRial, quoteId: quote.id, expiresAt: quote.expiresAt.toISOString(), baseline }
    await db.insert(idempotencyKeys).values({ scope: `resize:${user.id}:${id}`, key: quote.id, responseStatus: 200, responseBody: payload, expiresAt: quote.expiresAt })
    return { data: { ...payload, currentPriceRial: sub!.priceRial, period: sub!.billingInterval, effectiveAt: sub!.nextInvoiceAt.toISOString(), expiresAt: quote.expiresAt.toISOString(), immediateChargeRial: 0 } }
  })
  app.post('/servers/:id/management/actions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = requireUser(request), { id } = parse(params, request.params), server = await getServerForUser(db, user.id, id)
    const input = parse(actionInput, request.body), key = parse(z.string().min(8).max(100), request.headers['idempotency-key'])
    if (input.hostname !== server.hostname) throw new ValidationError('نام سرور برای تأیید مطابقت ندارد')
    let payload: Record<string, unknown> = input
    if (input.action === 'resize') {
      // A lost acceptance response must remain recoverable after quote expiry.
      // Reuse only the original persisted payload, never new client prices.
      const previous = await db.query.providerOperations.findFirst({ where: t => eq(t.businessKey, `management:${user.id}:${key}`) })
      if (previous) {
        const original = (previous.requestMetadata as { input?: Record<string, unknown> })?.input
        if (previous.referenceId !== id || previous.action !== 'resize' || original?.quoteId !== input.quoteId || original?.upgradeDisk !== input.upgradeDisk) throw new ConflictError('این کلید برای درخواست دیگری استفاده شده است')
        payload = original
      } else {
        const preview = await db.query.idempotencyKeys.findFirst({ where: t => and(eq(t.scope, `resize:${user.id}:${id}`), eq(t.key, input.quoteId), gt(t.expiresAt, new Date())) })
        if (!preview || (preview.responseBody as { upgradeDisk?: boolean })?.upgradeDisk !== input.upgradeDisk) throw new ConflictError('پیش‌نمایش قیمت منقضی شده یا تغییر کرده است؛ دوباره بررسی کنید')
        const view = await customerProvider(server).inspect(server.providerServerId!)
        if (view.state !== 'suspended') throw new ValidationError('ارائه‌دهنده هنوز خاموش بودن سرور را تأیید نکرده است')
        payload = preview.responseBody as Record<string, unknown>
      }
    }
    if (input.action === 'attach_iso') throw new ValidationError('انتخاب و مالکیت ISO در این پروژه هنوز پشتیبانی نمی‌شود')
    const operation = await requestManagement(db, user, id, input.action, payload, key)
    await queues.addServerAction({ operationId: operation.id, serverId: server.id, action: input.action })
    return reply.status(202).send({ data: managementDto(operation) })
  })
  app.get('/servers/:id/metrics', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const user = requireUser(request), { id } = parse(params, request.params), { window } = parse(z.object({ window: z.enum(['1h', '6h', '24h']).default('1h') }), request.query)
    const server = await getServerForUser(db, user.id, id), manager = customerProvider(server), key = `${id}:${window}`
    const prior = metricCache.get(key)
    if (prior && prior.expiresAt > Date.now()) return { data: await prior.value }
    const hours = Number(window.replace('h', '')), end = new Date(Math.floor(Date.now() / 60000) * 60000), start = new Date(end.getTime() - hours * 3600000)
    if (metricCache.size >= 200) metricCache.delete(metricCache.keys().next().value!)
    const value = manager.metrics(server.providerServerId!, start, end, hours === 1 ? 60 : hours === 6 ? 120 : 300)
    metricCache.set(key, { expiresAt: Date.now() + 60000, value })
    try { return { data: await value } } catch (error) { metricCache.delete(key); throw error }
  })
  app.post('/servers/:id/credentials/claim', async (request, reply) => {
    const user = requireUser(request), { id } = parse(params, request.params), { operationId } = parse(z.object({ operationId: z.string().uuid() }).strict(), request.body)
    reply.header('Pragma', 'no-cache')
    return { data: await claimServerPassword(db, user, id, operationId) }
  })
  app.post('/servers/:id/credentials/ack', async request => {
    const user = requireUser(request), { id } = parse(params, request.params), { operationId } = parse(z.object({ operationId: z.string().uuid() }).strict(), request.body)
    await getServerForUser(db, user.id, id)
    await db.update(serverSecrets).set({ encrypted: null, acknowledgedAt: new Date() }).where(and(eq(serverSecrets.serverId, id), eq(serverSecrets.userId, user.id), eq(serverSecrets.sessionId, user.sessionId), eq(serverSecrets.operationId, operationId)))
    return { data: { acknowledged: true } }
  })
}
