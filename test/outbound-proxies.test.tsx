import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { SystemSettingsLayout } from '../src/admin/SystemSettings'
import { SystemOutboundProxies } from '../src/admin/SystemOutboundProxies'
import { outboundIntegrations, type OutboundStatus } from '../backend/src/contracts/outbound'

const profileId = '00000000-0000-4000-8000-000000000046', proof = '00000000-0000-4000-8000-000000000047'
let allowed: boolean, encryptionReady: boolean, data: OutboundStatus
let posts: Array<{ path: string; body: Record<string, unknown> }>, reads: string[]
beforeEach(() => {
  allowed = true; encryptionReady = true; posts = []; reads = []
  data = { revision: 'initial', hetznerConsole: { latest: null, lastFailure: null }, profiles: [{ id: profileId, name: 'Europe fixture', type: 'socks5', host: 'proxy.example.test', port: 1080, timeoutMs: 10000, enabled: true, authenticated: true, lastTest: null }],
    integrations: outboundIntegrations.map(id => ({ id, route: { enabled: false, profileId: null, failurePolicy: 'closed' }, active: { route: 'direct', profileId: null }, lastTest: null })) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, '')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push({ path, body })
      if (path.endsWith('/authorize')) return Response.json({ data: { proof } })
      if (path.endsWith('/test')) return Response.json({ data: { integration: 'hetzner', ok: true, reachable: true, route: 'proxy', profileId, revision: data.revision,
        category: 'none', latencyMs: 25, testedAt: '2026-11-15T08:00:00Z', lastSuccessAt: '2026-11-15T08:00:00Z', httpStatus: 200 } })
      return Response.json({ data: { revision: 'initial' } })
    }
    reads.push(path)
    if (path.endsWith('/capabilities')) return Response.json({ data: { allowed, encryptionReady } })
    if (path.endsWith('/outbound')) return Response.json({ data })
    throw new Error(`Unexpected fixture path: ${path}`)
  }))
})
const open = () => render(<MemoryRouter initialEntries={['/admin/settings/outbound']}><Routes><Route path="/admin/settings" element={<SystemSettingsLayout />}><Route path="outbound" element={<SystemOutboundProxies />} /></Route></Routes></MemoryRouter>)
async function ready() { open(); await screen.findByRole('heading', { name: 'شبکه و پراکسی خروجی' }) }
function integration(name: string) { return within(screen.getByRole('heading', { name, exact: true }).closest('article')!) }

describe('admin outbound panel', () => {
  it('uses the existing settings access gate without fetching proxy settings for unauthorized users', async () => {
    allowed = false; open()
    await screen.findByText('دسترسی مدیریت مجاز نیست')
    expect(reads).not.toContain('/admin/settings/outbound')
  })
  it('lets an existing admin save without an additional store key and defaults new profiles to disabled', async () => {
    encryptionReady = false; await ready()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'ذخیرهٔ پراکسی' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'فعال‌بودن پروفایل' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText(/STORE_SECRET_KEY/)).toBeNull()
    expect(screen.getByRole('link', { name: 'شبکه و پراکسی خروجی' })).toBeTruthy()
    expect(posts).toEqual([])
  })
  it('keeps stored credentials masked during editing and binds a replacement to the sensitive-operation proof', async () => {
    const user = userEvent.setup(); await ready()
    await user.click(screen.getByRole('button', { name: 'ویرایش Europe fixture' }))
    const username = screen.getByLabelText<HTMLInputElement>('نام کاربری جدید (اختیاری)'), password = screen.getByLabelText<HTMLInputElement>('رمز جدید (اختیاری)')
    expect(username.value).toBe(''); expect(password.value).toBe(''); expect(password.type).toBe('password')
    await user.type(username, 'new-fixture-user'); await user.type(password, 'new-fixture-secret')
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ پراکسی' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[0].body.action).toBe('outbound.profile')
    const { proof: submittedProof, ...payload } = posts[1].body
    expect(submittedProof).toBe(proof); expect(payload).toEqual(posts[0].body.payload)
    expect(payload).toMatchObject({ id: profileId, username: 'new-fixture-user', password: 'new-fixture-secret' })
    await waitFor(() => expect(password.value).toBe(''))
  })
  it('returns a service to Direct with an explicit route change', async () => {
    data.integrations[0] = { ...data.integrations[0], route: { enabled: true, profileId, failurePolicy: 'closed' }, active: { route: 'proxy', profileId } }
    const user = userEvent.setup(); await ready()
    const card = integration('هتزنر')
    await user.selectOptions(card.getByLabelText('پراکسی هتزنر'), '')
    await user.click(card.getByRole('button', { name: 'ذخیرهٔ مسیر هتزنر' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body).toMatchObject({ integration: 'hetzner', enabled: false, profileId: null, failurePolicy: 'closed', proof })
  })
  it('shows the last console failure and provides no direct fallback control for Hetzner', async () => {
    data.hetznerConsole.latest = { route: 'proxy', profileId, category: 'authentication', latencyMs: 27, checkedAt: '2026-11-15T08:00:00Z', revision: 'initial' }
    await ready()
    const card = integration('هتزنر')
    expect(card.getByText(/پراکسی · نیازمند بررسی اعتبارنامهٔ سرویس · 27 ms/)).toBeTruthy()
    expect(card.queryByLabelText('سیاست خطای هتزنر')).toBeNull()
  })
  it('assigns ParsGreen independently without changing other integration routes', async () => {
    const user = userEvent.setup(); await ready()
    const sms = integration('پارس‌گرین (پیامک)')
    expect(sms.getByText('مسیر فعلی: مستقیم')).toBeTruthy()
    await user.selectOptions(sms.getByLabelText('پراکسی پارس‌گرین (پیامک)'), profileId)
    await user.click(sms.getByRole('button', { name: 'ذخیرهٔ مسیر پارس‌گرین (پیامک)' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1].body).toMatchObject({ integration: 'parsgreen', enabled: true, profileId, failurePolicy: 'closed' })
    expect(posts.filter(p => p.path.endsWith('/routes'))).toHaveLength(1)
  })
  it('tests only the selected approved integration and displays the reported route and latency', async () => {
    const user = userEvent.setup(); await ready()
    await user.click(screen.getByRole('button', { name: 'آزمون پراکسی Europe fixture' }))
    await screen.findByRole('heading', { name: 'نتیجهٔ آخرین آزمون: هتزنر' })
    expect(screen.getByText('آزمایش موفق · پراکسی')).toBeTruthy()
    expect(screen.getByText(/HTTP 200.*25 ms/)).toBeTruthy()
    expect(posts[1].body).toEqual({ revision: 'initial', integration: 'hetzner', profileId, confirm: true, proof })
    expect(posts[1].body).not.toHaveProperty('url')
  })
})
