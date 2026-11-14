import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { IpsPage, TrafficPackagesPage } from '../src/pages/InfrastructurePages'
import { ToastProvider } from '../src/components/ui/Toast'
// @ts-expect-error Shared synthetic fixture, never a real account/API.
import { fixture } from './fixtures.mjs'

vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'fixture-user', role: 'user' } }) }))
const scenarios = [
  { service: 'ips', path: '/ips', label: 'خرید آی‌پی', name: 'آی‌پی اختصاصی', page: <IpsPage />, history: '192.0.2.53', item: { id: 'ip-53', address: '192.0.2.53', version: 'IPv4', status: 'active', datacenter: 'fixture', server: 'Fixture server' } },
  { service: 'trafficPackages', path: '/traffic-packages', label: 'خرید بسته ترافیک', name: 'بسته ترافیک', page: <TrafficPackagesPage />, history: 'Fixture traffic history', item: { id: 'traffic-53', name: 'Fixture traffic history', connectedServers: 1, status: 'active' } },
] as const
let enabled: boolean, populated: boolean, fail: boolean, hold: boolean
let targetService: string
let release: () => void, purchases: string[]
beforeEach(() => {
  enabled = false; populated = false; fail = false; hold = false; purchases = []; release = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, '').split('?')[0]
    if (path === '/infrastructure/capabilities') {
      if (hold) await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error('fixture unavailable')
      return Response.json({ data: Object.fromEntries(scenarios.map(s => [s.service, { enabled: enabled && s.service === targetService, reason: `سرویس «${s.name}» هنوز در پلتفرم فعال نشده است` }])) })
    }
    const scenario = scenarios.find(s => s.path === path)
    if (scenario) {
      if (init?.method === 'POST') { purchases.push(path); return Response.json({ data: scenario.item }) }
      return Response.json({ data: populated ? [scenario.item] : [] })
    }
    return Response.json(fixture(path))
  }))
})
const open = (page: React.ReactNode) => render(<MemoryRouter><ToastProvider>{page}</ToastProvider></MemoryRouter>)
const disabled = (label: string) => screen.getAllByRole<HTMLButtonElement>('button', { name: label, exact: true }).every(b => b.disabled)

describe.each(scenarios)('$service purchase availability', scenario => {
  beforeEach(() => { targetService = scenario.service })
  it('disables both purchase entries before a click and explains unavailability persistently', async () => {
    open(scenario.page)
    const message = await screen.findByText(`سرویس «${scenario.name}» هنوز در پلتفرم فعال نشده است`)
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: scenario.label, exact: true })
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-describedby')).toBe(message.id)
      await userEvent.click(button)
    }
    expect(purchases).toEqual([])
  })
  it('retains existing resource history when new purchases are unavailable', async () => {
    populated = true; open(scenario.page)
    expect(await screen.findByText(scenario.history)).toBeTruthy()
    await screen.findByText(`سرویس «${scenario.name}» هنوز در پلتفرم فعال نشده است`)
    expect(disabled(scenario.label)).toBe(true)
    expect(purchases).toEqual([])
  })
  it('does not enable a purchase when the service capability is absent', async () => {
    const fallback = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => url.endsWith('/infrastructure/capabilities')
      ? Promise.resolve(Response.json({ data: {} })) : fallback(url, init)))
    open(scenario.page)
    await screen.findByText(`خرید ${scenario.name} فعلاً در دسترس نیست.`)
    expect(disabled(scenario.label)).toBe(true); expect(purchases).toEqual([])
  })
  it('fails closed while loading or disconnected, then enables both entries after an explicit successful recheck', async () => {
    hold = true; open(scenario.page)
    await screen.findByText(`در حال بررسی امکان خرید ${scenario.name}…`)
    expect(disabled(scenario.label)).toBe(true)
    fail = true; hold = false; release()
    await screen.findByText(new RegExp(`بررسی امکان خرید ${scenario.name} ناموفق بود`))
    expect(disabled(scenario.label)).toBe(true); expect(purchases).toEqual([])
    enabled = true; fail = false
    await userEvent.click(screen.getByRole('button', { name: 'بررسی دوبارهٔ امکان خرید' }))
    await waitFor(() => expect(disabled(scenario.label)).toBe(false))
    expect(screen.queryByText(/تا تأیید وضعیت/)).toBeNull()
    await userEvent.click(screen.getAllByRole('button', { name: scenario.label, exact: true })[1])
    await waitFor(() => expect(purchases).toEqual([scenario.path]))
  })
  it('keeps purchase enabled with an available capability and existing history', async () => {
    enabled = true; populated = true; open(scenario.page)
    await screen.findByText(scenario.history)
    await waitFor(() => expect(disabled(scenario.label)).toBe(false))
    await userEvent.click(screen.getByRole('button', { name: scenario.label, exact: true }))
    await waitFor(() => expect(purchases).toEqual([scenario.path]))
  })
  it('does not simulate a purchase when no API is configured', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    open(scenario.page)
    await screen.findByText(new RegExp(`بررسی امکان خرید ${scenario.name} ناموفق بود`))
    expect(disabled(scenario.label)).toBe(true); expect(purchases).toEqual([])
  })
})
