import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RegisterDomainPage } from '../src/pages/WizardPages'
import { ToastProvider } from '../src/components/ui/Toast'

let lookup: (domain: string) => Promise<Response>
let orders: unknown[]
const result = (domain: string, available = true) => Response.json({ data: { domain, available, pricePerYear: 100000 } })
beforeEach(() => {
  orders = []
  lookup = async domain => result(domain)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/domains/availability?')) return lookup(new URL(url, 'https://example.test').searchParams.get('domain')!)
    if (url === '/api/domains' && init?.method === 'POST') {
      orders.push(JSON.parse(String(init.body)))
      return Response.json({ data: { id: 'fixture-order', status: 'pending' } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }))
})
const open = () => render(<MemoryRouter initialEntries={['/domains/register']}><ToastProvider><Routes>
  <Route path="/domains/register" element={<RegisterDomainPage />} />
  <Route path="/domains" element={<h1>Fixture domain list</h1>} />
</Routes></ToastProvider></MemoryRouter>)
const next = () => screen.getByRole<HTMLButtonElement>('button', { name: 'مرحله بعد' })
const input = () => screen.getByRole('textbox', { name: 'جستجوی دامنه' })
const check = () => screen.getByRole('button', { name: 'بررسی', exact: true })
async function enter(domain = 'example.test') {
  const user = userEvent.setup()
  open()
  await user.type(input(), domain)
  return user
}

describe('domain registration availability guard', () => {
  it('blocks unchecked and unavailable domains without creating an order', async () => {
    lookup = async domain => result(domain, false)
    const user = await enter()
    expect(next().disabled).toBe(true)
    await user.click(next())
    await user.click(check())
    await screen.findByText('این دامنه در دسترس نیست؛ نام دیگری را امتحان کنید.')
    expect(next().disabled).toBe(true)
    await user.click(next())
    expect(screen.queryByRole('button', { name: 'تایید و ثبت دامنه' })).toBeNull()
    expect(orders).toEqual([])
  })

  it('allows a successfully checked exact domain through finance and final submission', async () => {
    const user = await enter('https://available.test/')
    await user.click(check())
    await screen.findByText('این دامنه برای ثبت در دسترس است.')
    await user.click(next())
    await user.selectOptions(screen.getByLabelText('دوره ثبت'), '2')
    await user.click(next())
    expect(screen.getByText('available.test')).toBeTruthy()
    expect(orders).toEqual([])
    await user.click(screen.getByRole('button', { name: 'تایید و ثبت دامنه' }))
    await screen.findByRole('heading', { name: 'Fixture domain list' })
    expect(orders).toEqual([{ domain: 'available.test', periodYears: 2 }])
  })

  it('invalidates a successful result after going back and changing the domain, even if restored', async () => {
    const user = await enter()
    await user.click(check())
    await user.click(next())
    await user.click(next())
    await user.click(screen.getByRole('button', { name: 'مرحله قبل' }))
    await user.click(screen.getByRole('button', { name: 'مرحله قبل' }))
    await user.type(input(), 'x')
    expect(next().disabled).toBe(true)
    expect(screen.queryByText('این دامنه برای ثبت در دسترس است.')).toBeNull()
    await user.keyboard('{Backspace}')
    expect(next().disabled).toBe(true)
    await user.click(check())
    expect(next().disabled).toBe(false)
    expect(orders).toEqual([])
  })

  it.each(['new.test', 'old.test'])('ignores an old response while the current lookup for %s is pending', async currentDomain => {
    const pending: Array<{ domain: string; resolve: (response: Response) => void }> = []
    lookup = domain => new Promise(resolve => { pending.push({ domain, resolve }) })
    const user = await enter('old.test')
    await user.click(check())
    expect(next().disabled).toBe(true)
    await user.clear(input())
    await user.type(input(), currentDomain)
    await user.click(check())
    await act(async () => { pending[0].resolve(result(pending[0].domain)) })
    expect(next().disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'در حال بررسی...' }).disabled).toBe(true)
    expect(screen.queryByText('این دامنه برای ثبت در دسترس است.')).toBeNull()
    await act(async () => { pending[1].resolve(result(pending[1].domain, false)) })
    await screen.findByText('این دامنه در دسترس نیست؛ نام دیگری را امتحان کنید.')
    expect(next().disabled).toBe(true)
    expect(orders).toEqual([])
  })

  it.each(['failure', 'unavailable', 'mismatched', 'empty', 'no-api'])('does not retain prior approval after a %s recheck', async mode => {
    const user = await enter()
    await user.click(check())
    expect(next().disabled).toBe(false)
    lookup = async domain => {
      if (mode === 'failure') throw new Error('Fixture lookup failed')
      if (mode === 'empty') return Response.json({ data: null })
      return result(mode === 'mismatched' ? 'another.test' : domain, mode !== 'unavailable')
    }
    if (mode === 'no-api') vi.stubEnv('VITE_API_BASE_URL', '')
    await user.click(check())
    await waitFor(() => expect(check()).toBeTruthy())
    expect(next().disabled).toBe(true)
    expect(screen.queryByText('این دامنه برای ثبت در دسترس است.')).toBeNull()
    await user.click(next())
    expect(orders).toEqual([])
  })
})
