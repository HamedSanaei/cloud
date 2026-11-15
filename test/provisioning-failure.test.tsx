import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ServerTableRow } from '../src/components/servers/ServerPrimitives'
import type { Server } from '../src/lib/types'
// @ts-expect-error Synthetic shared loopback fixture; no real account or provider calls.
import { readyServer } from './server-management-fixtures.mjs'

const open = (billing: 'refunded' | 'captured' | 'not_charged', unknown = false) => {
  const server: Server = { ...readyServer, id: 'order:fixture-67', status: 'building', lifecycle: unknown ? 'outcome_unknown' : 'failed',
    tracking: { ...readyServer.tracking, state: unknown ? 'outcome_unknown' : 'failed', serverId: null,
      failure: { code: unknown ? 'outcome_unknown' : 'capacity_unavailable', billing, reference: 'ORD-FIXTURE-67',
        message: unknown ? 'نتیجهٔ ساخت هنوز قطعی نیست و در حال بررسی است.' : 'ظرفیت دیتاسنتر انتخابی تأیید نشد.',
        nextStep: unknown ? 'سفارش تازه نسازید؛ نتیجه را از پشتیبانی بپرسید.' : 'وضعیت سفارش را با شمارهٔ پیگیری بررسی کنید.',
        canChooseAlternative: !unknown && billing !== 'captured' } } }
  return render(<MemoryRouter><table><tbody><ServerTableRow server={server} /></tbody></table></MemoryRouter>)
}
describe('customer provisioning failure details', () => {
  it('shows the capacity reason, confirmed refund, reference and safe alternative action', () => {
    open('refunded')
    expect(screen.getByText('خطای ساخت')).toBeTruthy()
    expect(screen.getByText('ظرفیت دیتاسنتر انتخابی تأیید نشد.')).toBeTruthy()
    expect(screen.getByText('مبلغ پرداخت‌شده به کیف پول بازگردانده شد.')).toBeTruthy()
    expect(screen.getByText('ORD-FIXTURE-67')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'پیگیری از پشتیبانی' }).getAttribute('href')).toBe('/tickets')
    expect(screen.getByRole('link', { name: 'انتخاب پلن یا دیتاسنتر دیگر' }).getAttribute('href')).toBe('/servers/create')
  })
  it('does not claim an unreturned payment was refunded or encourage a second purchase', () => {
    open('captured')
    expect(screen.getByText('مبلغ کسرشده هنوز بازگردانده نشده و نیازمند پیگیری است.')).toBeTruthy()
    expect(screen.queryByText('مبلغ پرداخت‌شده به کیف پول بازگردانده شد.')).toBeNull()
    expect(screen.queryByRole('link', { name: 'انتخاب پلن یا دیتاسنتر دیگر' })).toBeNull()
  })
  it('keeps ambiguous outcomes under review with no retry action', () => {
    open('captured', true)
    expect(screen.getByText('نتیجه نامشخص')).toBeTruthy()
    expect(screen.getByText('سفارش تازه نسازید؛ نتیجه را از پشتیبانی بپرسید.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'انتخاب پلن یا دیتاسنتر دیگر' })).toBeNull()
  })
  it('states explicitly when there is no captured payment', () => {
    open('not_charged')
    expect(screen.getByText('مبلغی بابت این سفارش از کیف پول کسر نشده است.')).toBeTruthy()
  })
})
