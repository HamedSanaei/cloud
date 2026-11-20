import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { randomUUID } from 'node:crypto'
import { chargeRequests, invoices, notifications, orders, servers, tickets, users } from '../../src/db/schema.js'
import { createSession } from '../../src/modules/auth/service.js'
import { dbAvailable, getTestContext, testLogger, truncateAll } from '../helpers.js'
import { staffTicketAction } from '../../src/modules/tickets/service.js'

describe.skipIf(!dbAvailable)('customer order and financial history searches', () => {
  let ctx: Awaited<ReturnType<typeof getTestContext>>
  let app: FastifyInstance
  let headers: { authorization: string }
  let otherHeaders: typeof headers
  let customerId: string
  let otherId: string

  beforeAll(async () => {
    ctx = await getTestContext()
    await truncateAll(ctx.db)
    const [customer, other] = await ctx.db.insert(users).values([
      { email: 'history-customer@test.local', passwordHash: 'fixture-only', status: 'active' },
      { email: 'history-other@test.local', passwordHash: 'fixture-only', status: 'active' },
    ]).returning({ id: users.id })
    customerId = customer!.id
    otherId = other!.id
    headers = { authorization: 'Bearer ' + (await createSession(ctx.db, customerId, {})).token }
    otherHeaders = { authorization: 'Bearer ' + (await createSession(ctx.db, otherId, {})).token }
    const history = Array.from({ length: 51 }, (_, index) => ({
      userId: customer!.id, index, createdAt: new Date(Date.UTC(2025, 0, index + 1)),
    }))
    await ctx.db.insert(orders).values(history.map<typeof orders.$inferInsert>(({ userId, index, createdAt }) => ({
      userId, createdAt, orderNumber: `ORD-QA-${100 + index}`, status: index === 0 ? 'requires_review' : 'failed',
      provider: 'hetzner', totalRial: 100, providerProductId: 'fixture', providerLocation: 'nbg1', hostname: 'fixture', operatingSystem: 'ubuntu',
    })))
    await ctx.db.insert(invoices).values(history.map<typeof invoices.$inferInsert>(({ userId, index, createdAt }) => ({
      userId, createdAt, invoiceNumber: `INV-${100 + index}`, status: index === 0 ? 'overdue' : index === 1 ? 'open' : 'paid',
      dueAt: new Date('2025-04-01'), totalRial: 100, subtotalRial: 100, taxRial: 0, description: index === 0 ? 'تمدید fixture — MONTHLY' : null,
    })))
    await ctx.db.insert(chargeRequests).values(history.map(({ userId, index, createdAt }) => ({
      userId, createdAt, number: `PAY-${100 + index}`, amountRial: 100, status: index === 0 ? 'processing' : 'approved',
    })))
    app = await buildApp({ db: ctx.db, queues: ctx.queues, logger: testLogger })
  })
  afterAll(async () => { await app?.close(); await ctx?.close() })
  const read = async (path: string, forOther = false) => {
    const response = await app.inject({ url: '/api' + path, headers: forOther ? otherHeaders : headers })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }

  it('finds a user’s old order before applying the limit and normalizes mixed digits', async () => {
    const { data } = await read('/servers')
    expect(data).toHaveLength(50)
    expect(data.every((row: { lifecycle: string }) => row.lifecycle === 'failed')).toBe(true)
    const path = '/servers/provisioning/search?reference=' + encodeURIComponent('ord-QA-۱٠۰')
    expect((await read(path)).data).toMatchObject([{ lifecycle: 'requires_review', tracking: { failure: { reference: 'ORD-QA-100' } } }])
    expect((await read(path, true)).data).toEqual([])
  })

  it.each([['invoices', 'INV', 'overdue'], ['charge-requests', 'PAY', 'processing']])(
    'searches, filters and paginates the entire authorized %s history',
    async (path, prefix, status) => {
      const first = await read('/' + path)
      expect(first.data).toHaveLength(50)
      expect(first.pagination.nextOffset).toBe(50)
      const second = await read('/' + path + '?offset=50')
      expect(second.data).toMatchObject([{ number: prefix + '-100', status }])
      expect(second.pagination.nextOffset).toBeNull()
      const filter = '/' + path + '?' + new URLSearchParams({ search: prefix.toLowerCase() + '-۱٠۰', status })
      expect((await read(filter)).data).toMatchObject([{ number: prefix + '-100', status }])
      expect((await read(filter, true)).data).toEqual([])
      const filtered = (await read('/' + path + '?status=' + status)).data
      expect(filtered.map((row: { number: string }) => row.number)).toEqual(path === 'invoices' ? ['INV-101', 'INV-100'] : ['PAY-100'])
      if (path === 'invoices') {
        expect((await read('/invoices?status=pending')).data).toEqual([])
        expect((await read('/invoices?search=' + encodeURIComponent('ماهانه'))).data).toMatchObject([{ number: 'INV-100' }])
        expect((await read('/invoices/' + second.data[0].id)).data.status).toBe('overdue')
      }
    },
  )

  it('finds an older answered ticket and marks only replies the customer actually opened', async () => {
    const [ticket] = await ctx.db.insert(tickets).values(Array.from({ length: 51 }, (_, index) => ({
      userId: customerId, title: `Old support ticket ${index}`, department: 'technical', status: index === 0 ? 'pending' : 'closed',
      createdAt: new Date(Date.UTC(2025, 0, index + 1)), updatedAt: new Date(Date.UTC(2025, 0, index + 1)),
    }))).returning({ id: tickets.id })
    await staffTicketAction(ctx.db, otherId, ticket!.id, { requestId: randomUUID(), reply: 'First reply' })
    expect((await read('/tickets/summary')).data).toMatchObject({ total: 51, answered: 1, unread: 1 })
    expect((await read('/tickets?status=answered&department=technical')).data).toMatchObject([{ id: ticket!.id, unread: true }])
    const path = '/tickets/' + ticket!.id
    const first = (await read(path)).data.replies[0]
    expect(first).toMatchObject({ body: 'First reply', read: false })
    await staffTicketAction(ctx.db, otherId, ticket!.id, { requestId: randomUUID(), reply: 'Second reply' })
    const mark = (replyIds: string[], asOther = false) => app.inject({ url: '/api' + path + '/read', method: 'POST',
      headers: asOther ? otherHeaders : headers, payload: { replyIds } })
    expect((await mark([first.id], true)).statusCode).toBe(404)
    expect((await mark([first.id])).statusCode).toBe(200)
    expect((await read('/tickets/summary')).data.unread).toBe(1)
    const detail = (await read(path)).data
    expect(detail.replies).toMatchObject([{ read: true }, { read: false }])
    expect((await mark([detail.replies[1].id])).statusCode).toBe(200)
    expect((await read('/tickets/summary')).data.unread).toBe(0)
    expect((await read('/tickets?status=answered')).data).toMatchObject([{ id: ticket!.id, unread: false }])
  })

  it('marks all 51 notifications for this account and preserves an unrelated account', async () => {
    await ctx.db.insert(notifications).values([
      ...Array.from({ length: 51 }, (_, index) => ({ userId: customerId, title: `Notice ${index}`, createdAt: new Date(Date.UTC(2025, 0, index + 1)) })),
      { userId: otherId, title: 'Other account notice' },
    ])
    const initial = await read('/notifications')
    expect(initial.data).toHaveLength(50)
    expect(initial.unreadCount).toBe(51)
    const response = await app.inject({ method: 'PATCH', url: '/api/notifications/read', headers, payload: { all: true } })
    expect(response.statusCode).toBe(200)
    expect((await read('/notifications')).unreadCount).toBe(0)
    expect((await read('/notifications', true)).unreadCount).toBe(1)
  })

  it('sorts orders and servers before limiting, counts overdue invoices, and lists the counted IPs', async () => {
    const newServer = { userId: customerId, provider: 'hetzner', providerProductId: 'fixture', providerLocation: 'nbg1',
      hostname: 'newest-active-server', operatingSystem: 'ubuntu' }
    const [order] = await ctx.db.insert(orders).values({ ...newServer, orderNumber: 'ORD-NEWEST', status: 'active', totalRial: 100 }).returning({ id: orders.id })
    await ctx.db.insert(servers).values({ ...newServer, orderId: order!.id, status: 'active',
      activatedAt: new Date(), vcpu: 2, memoryMb: 2048, diskGb: 20, ipv4: '192.0.2.10', ipv6: '2001:db8::10' })
    const recent = (await read('/servers?limit=5')).data
    expect(recent).toHaveLength(5)
    expect(recent[0]).toMatchObject({ name: newServer.hostname, lifecycle: 'ready' })
    const summary = (await read('/dashboard/summary')).data
    const { data: ips } = await read('/ips')
    expect(summary).toMatchObject({ unpaidInvoices: 2, activeServers: 1, ips: ips.length })
    expect(ips).toMatchObject([{ address: '192.0.2.10', version: 'IPv4' }, { address: '2001:db8::10', version: 'IPv6' }])
    expect((await read('/ips', true)).data).toEqual([])
  })
})
