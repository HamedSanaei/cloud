import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletPage } from '../src/pages/FinancePages'
import { ToastProvider } from '../src/components/ui/Toast'
import { movementAmounts, transactionsCsv } from '../src/lib/walletHistory'
import type { Transaction } from '../src/lib/types'

vi.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: { timezone: 'UTC' } }) }))

const entry = (values: Partial<Transaction> = {}): Transaction => ({
  id: 'entry', wallet: 'کیف پول', walletId: 'wallet', description: 'شرح', date: new Date().toISOString(),
  type: 'deposit', amount: 150000, amountRial: 1500000, status: 'success', ...values,
})

afterEach(() => vi.restoreAllMocks())

describe('wallet transaction columns', () => {
  it.each([
    ['deposit', 1000, ['۱۰۰ تومان', '—']], ['refund', 1000, ['۱۰۰ تومان', '—']], ['manual_credit', 1000, ['۱۰۰ تومان', '—']],
    ['renewal', -1000, ['—', '۱۰۰ تومان']], ['manual_debit', -1000, ['—', '۱۰۰ تومان']], ['purchase', -1, ['—', '۰٫۱ تومان']],
    ['adjustment', -1000, ['—', '۱۰۰ تومان']], ['adjustment', 0, ['—', '—']],
  ])('puts %s (%s rial) in the matching column', (type, amountRial, expected) => {
    expect(movementAmounts(entry({ type, amountRial }))).toEqual(expected)
  })

  it.each(['pending', 'failed', 'voided'])('does not display %s amounts as movements', status => {
    expect(movementAmounts(entry({ status, direction: 'credit' }))).toEqual(['—', '—'])
  })

  it('preserves the foreign currency of an existing platform debit without a second sign', () => {
    expect(movementAmounts(entry({ amount: -500, amountRial: undefined, formattedAmount: '\u061c−5.00 USD' }))).toEqual(['—', '5.00 USD'])
  })

  it('exports matching columns, original references and spreadsheet-safe values with a UTF-8 BOM', () => {
    const output = transactionsCsv([
      entry({ description: ' =SUM("1")', wallet: '\ttext', type: 'purchase', referenceType: 'primary_ipv4_replacement', referenceId: '@server', amountRial: -1500000 }),
      entry({ description: 'بازپرداخت', type: 'refund' }),
      entry({ description: 'درخواست', status: 'failed' }),
    ], 'UTC')
    expect(output.charCodeAt(0)).toBe(0xfeff)
    const [header, debit, credit, failed] = output.split('\r\n')
    expect(header).toContain('"کیف پول","واریز (+)","برداشت (-)"')
    expect(debit).toContain(`"' =SUM(""1"")","'\ttext","—","۱۵۰,۰۰۰ تومان"`)
    expect(debit).toContain(`"تعویض IPv4 اصلی","primary_ipv4_replacement","'@server"`)
    expect(credit).toContain('"کیف پول","۱۵۰,۰۰۰ تومان","—"')
    expect(failed).toContain('"کیف پول","—","—"')
    expect(failed).toContain('"ناموفق"')
  })

  it('keeps history from previous wallet IDs visible without a wallet selector', async () => {
    const entries = [
      entry({ id: 'ip', description: 'تعویض سرور آزمایشی', amountRial: -1500000, type: 'purchase', referenceType: 'primary_ipv4_replacement', referenceId: 'server-id' }),
      entry({ id: 'refund', description: 'جبران هزینه', walletId: 'other', wallet: 'کیف دوم', type: 'refund' }),
      entry({ id: 'traffic', description: 'مصرف مازاد آزمایشی', amountRial: -500, type: 'purchase', referenceType: 'traffic_overage' }),
      entry({ id: 'failed', description: 'پرداخت آزمایشی', status: 'failed' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ data: url.split('?')[0].endsWith('/wallets/transactions') ? entries
      : url.endsWith('/wallets') ? [{ id: 'wallet', name: 'کیف پول', balance: 0 }, { id: 'other', name: 'کیف دوم', balance: 0 }]
        : url.endsWith('/wallets/summary') ? { totalBalance: 0 } : { enabled: false } })))
    render(<MemoryRouter initialEntries={['/wallet']}><ToastProvider><WalletPage /></ToastProvider></MemoryRouter>)
    await screen.findByRole('columnheader', { name: 'واریز (+)' })
    const row = (name: string) => within(screen.getByText(name).closest('tr')!)
    const amounts = (name: string) => row(name).getAllByRole('cell').slice(2, 4).map(cell => cell.textContent)
    expect(amounts('تعویض سرور آزمایشی')).toEqual(['—', '۱۵۰,۰۰۰ تومان'])
    expect(row('تعویض سرور آزمایشی').getByRole('link').getAttribute('href')).toBe('/servers/server-id')
    expect(amounts('جبران هزینه')).toEqual(['۱۵۰,۰۰۰ تومان', '—'])
    expect(amounts('مصرف مازاد آزمایشی')).toEqual(['—', '۵۰ تومان'])
    expect(row('مصرف مازاد آزمایشی').getByText('ترافیک مازاد')).toBeTruthy()
    expect(amounts('پرداخت آزمایشی')).toEqual(['—', '—'])
    expect(row('پرداخت آزمایشی').getByText('ناموفق')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'کیف پول' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ایجاد کیف پول' })).toBeNull()
    expect(screen.getByText('تعویض سرور آزمایشی')).toBeTruthy()
    expect(screen.getByText('جبران هزینه')).toBeTruthy()
  })

  it('fetches every server page and exports the full selected window', async () => {
    const entries = Array.from({ length: 168 }, (_, index) => entry({ id: String(index), description: `ledger-${index}`, date: new Date(Date.now() - (index < 80 ? 1 : 48) * 3600000).toISOString() }))
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      const url = new URL(path, 'https://fixture.test')
      if (!url.pathname.endsWith('/transactions')) return Response.json({ data: { enabled: false, totalBalance: 0 } })
      const since = Date.parse(url.searchParams.get('since')!), until = Date.parse(url.searchParams.get('until')!)
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'))
      const rows = entries.filter(row => Date.parse(row.date) >= since && Date.parse(row.date) < until)
      return Response.json({ data: rows.slice(offset, offset + limit), pagination: { nextOffset: offset + limit < rows.length ? offset + limit : null } })
    }))
    const objectUrl = vi.fn(() => 'blob:wallet-test')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = objectUrl; static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<MemoryRouter><ToastProvider><WalletPage /></ToastProvider></MemoryRouter>)
    expect(await screen.findByText(/۸۰ تراکنش/)).toBeTruthy()
    const week = screen.getByRole('button', { name: '۷ روز اخیر' })
    fireEvent.click(week)
    expect(await screen.findByText(/۱۶۸ تراکنش/)).toBeTruthy()
    expect(week.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '۲۴ ساعت اخیر' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'صفحهٔ بعد' }))
    expect(screen.getByText('ledger-50')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'دانلود' }))
    const [blob] = (objectUrl.mock.calls as unknown as [Blob][])[0]
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(blob)
    })
    expect(csv.split('\r\n')).toHaveLength(169)
    expect(csv).toContain('ledger-167')
  })
  it('validates Latin, Persian and Arabic top-up amounts with the same field error', async () => {
    const attempts: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/wallets/recharge/options')) return Response.json({ data: { enabled: true, gateways: ['tabapay'] } })
      if (path.endsWith('/wallets/recharges')) {
        attempts.push(JSON.parse(String(init?.body)).amountToman)
        return Response.json({ data: { id: 'fixture', status: 'pending', paymentUrl: null } })
      }
      return Response.json({ data: { enabled: false, totalBalance: 0 } })
    }))
    render(<MemoryRouter><ToastProvider><WalletPage /></ToastProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'شارژ کیف پول' }))
    await screen.findByRole('option', { name: 'تاباپی' })
    const amount = screen.getByRole('textbox', { name: 'مبلغ (تومان)' })
    const submit = screen.getByRole('button', { name: 'دریافت لینک پرداخت امن' })
    for (const text of ['9999', '۹۹۹۹', '٩٩٩٩']) {
      fireEvent.change(amount, { target: { value: text } })
      fireEvent.click(submit)
      expect(await screen.findByText(/باید بین ۱۰٬۰۰۰/)).toBeTruthy()
      expect(amount.getAttribute('aria-invalid')).toBe('true')
    }
    expect(attempts).toEqual([])
    fireEvent.change(amount, { target: { value: '۱۰٠۰۰' } })
    expect(screen.queryByText(/باید بین ۱۰٬۰۰۰/)).toBeNull()
    fireEvent.click(submit)
    expect(await screen.findByRole('link', { name: 'پیگیری نتیجه پرداخت' })).toBeTruthy()
    expect(attempts).toEqual([10000])
  })
})
