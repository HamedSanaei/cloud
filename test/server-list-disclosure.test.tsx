import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ServerTableRow } from '../src/components/servers/ServerPrimitives'
import type { Server } from '../src/lib/types'
// @ts-expect-error Synthetic fixture, shared only with loopback previews.
import { readyServer } from './server-management-fixtures.mjs'

const failed: Server = { ...readyServer, id: 'order:sample', serverId: undefined, lifecycle: 'failed', status: 'building', ip: undefined,
  tracking: { ...readyServer.tracking, serverId: null, state: 'failed', failure: { code: 'capacity_unavailable', billing: 'captured', reference: 'REAL-API-REFERENCE-123', message: 'متن کامل علت خطا', nextStep: 'راهنمای کامل پیگیری', canChooseAlternative: false } } }
function open(servers: Server[]) {
  return render(<MemoryRouter><table><tbody>{servers.map(server => <ServerTableRow key={server.id} server={server} />)}</tbody></table></MemoryRouter>)
}

describe('compact server rows', () => {
  it('keeps full guidance outside the primary row and supports keyboard disclosure with stable table semantics', async () => {
    const user = userEvent.setup()
    open([failed])
    const trigger = screen.getByRole('button', { name: 'علت خطا و پیگیری' })
    const row = trigger.closest('tr')!
    const details = document.getElementById(trigger.getAttribute('aria-controls')!)!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(details.hidden).toBe(true)
    expect(within(row).queryByText('متن کامل علت خطا')).toBeNull()
    expect(screen.queryByRole('link', { name: 'پیگیری از پشتیبانی' })).toBeNull()
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(trigger)
    expect(details.hidden).toBe(false)
    expect(details.getAttribute('aria-labelledby')).toBe(trigger.id)
    expect(details.querySelector('td')?.colSpan).toBe(5)
    expect(screen.getByText('متن کامل علت خطا')).toBeTruthy()
    expect(screen.getByText('راهنمای کامل پیگیری')).toBeTruthy()
    await user.keyboard('[Space]')
    expect(details.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('isolates disclosures, copies actual tracking references and never mutates source data', async () => {
    const user = userEvent.setup(), writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const rows = [failed, { ...failed, id: 'order:other', name: 'other-node' }]
    const original = structuredClone(rows)
    open(rows)
    const buttons = screen.getAllByRole('button', { name: 'علت خطا و پیگیری' })
    await user.click(buttons[0])
    expect(buttons[1].getAttribute('aria-expanded')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'کپی شناسه REAL-API-REFERENCE-123' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('REAL-API-REFERENCE-123')
    expect(await screen.findByText('شناسه کپی شد')).toBeTruthy()
    expect(rows).toEqual(original)
  })

  it('selects the complete reference for manual copying on clipboard denial', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    open([failed])
    await user.click(screen.getByRole('button', { name: 'علت خطا و پیگیری' }))
    await user.click(screen.getByRole('button', { name: 'کپی شناسه REAL-API-REFERENCE-123' }))
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'شناسه برای کپی دستی' })
    expect(input.value).toBe('REAL-API-REFERENCE-123')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(document.activeElement).toBe(input)
  })

  it.each(['failed', 'outcome_unknown', 'requires_review'] as const)('does not invent financial outcomes when %s has no failure payload', async lifecycle => {
    const user = userEvent.setup()
    open([{ ...failed, lifecycle, tracking: { ...failed.tracking!, state: lifecycle, failure: undefined } }])
    await user.click(screen.getByRole('button', { name: 'علت خطا و پیگیری' }))
    expect(screen.getByText('وضعیت مالی این سفارش هنوز تأیید نشده است؛ از پشتیبانی پیگیری کنید.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'انتخاب پلن یا دیتاسنتر دیگر' })).toBeNull()
  })

  it.each(['queued', 'provisioning'] as const)('allows read-only tracking of %s without fabricated refund or retry', async lifecycle => {
    const user = userEvent.setup()
    open([{ ...failed, lifecycle, tracking: { ...failed.tracking!, state: lifecycle, failure: undefined } }])
    await user.click(screen.getByRole('button', { name: 'پیگیری وضعیت' }))
    expect(screen.getByRole('region', { name: 'جزئیات وضعیت ساخت سرور' })).toBeTruthy()
    expect(screen.queryByText(/بازگردانده شد/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'انتخاب پلن یا دیتاسنتر دیگر' })).toBeNull()
  })

  it.each(['ready', 'terminated', 'delete_failed'] as const)('preserves local %s detail navigation', lifecycle => {
    open([{ ...readyServer, lifecycle }])
    expect(screen.getByRole('link', { name: 'مشاهده جزئیات' }).getAttribute('href')).toBe(`/servers/${readyServer.id}`)
    expect(screen.queryByRole('button', { name: 'علت خطا و پیگیری' })).toBeNull()
  })

  it('preserves platform management authorization and uses the platform identity for copying', () => {
    open([{ ...readyServer, platformServerId: 'platform-567' }])
    const action = screen.getByRole<HTMLButtonElement>('button', { name: 'مدیریت و نتیجه عملیات' })
    expect(action.disabled).toBe(true)
    expect(document.getElementById(action.getAttribute('aria-describedby')!)?.textContent).toContain('اتصال به پلتفرم')
    expect(screen.getByRole('button', { name: 'کپی شناسهٔ سرور platform-567' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'مشاهده جزئیات' })).toBeNull()
  })
})
