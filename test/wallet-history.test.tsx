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

  it('renders mixed movements, status, reference links and the wallet filter', async () => {
    const entries = [
      entry({ id: 'ip', description: 'تعویض سرور آزمایشی', amountRial: -1500000, type: 'purchase', referenceType: 'primary_ipv4_replacement', referenceId: 'server-id' }),
      entry({ id: 'refund', description: 'جبران هزینه', walletId: 'other', wallet: 'کیف دوم', type: 'refund' }),
      entry({ id: 'traffic', description: 'مصرف مازاد آزمایشی', amountRial: -500, type: 'purchase', referenceType: 'traffic_overage' }),
      entry({ id: 'failed', description: 'پرداخت آزمایشی', status: 'failed' }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ data: url.endsWith('/wallets/transactions') ? entries
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
    fireEvent.change(screen.getByRole('combobox', { name: 'کیف پول' }), { target: { value: 'other' } })
    expect(screen.queryByText('تعویض سرور آزمایشی')).toBeNull()
    expect(screen.getByText('جبران هزینه')).toBeTruthy()
  })
})
