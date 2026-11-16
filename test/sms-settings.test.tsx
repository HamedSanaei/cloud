import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SystemSmsSettings } from '../src/admin/SystemSmsSettings'

describe('persistent independent SMS switches', () => {
  let enabled: boolean, version: number, fail: boolean
  const request = vi.fn()
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  beforeEach(() => {
    enabled = false; version = 0; fail = false; request.mockReset()
    vi.stubGlobal('fetch', request.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        if (fail) return json({ message: 'تنظیم تغییر کرده؛ دوباره دریافت کنید', code: 'conflict' }, 409)
        enabled = body.enabled; version++
        return json({ data: { enabled, version } })
      }
      return json({ data: [{ key: 'ticketCreated', name: 'ثبت تیکت', group: 'تیکت‌ها', event: 'ticket.created', enabled, version,
        approval: 'approved-pattern', ready: true, blocked: enabled ? null : 'skipped_disabled', pattern: 'پارس سرور: تیکت %% ثبت شد. parserver.ir',
        sample: 'پارس سرور: تیکت 1052 ثبت شد. parserver.ir', variables: ['ticketNumber'], primaryLine: '9998883511', fallbackConfigured: true, history: [] }] })
    }))
  })
  it('persists one selected switch, sends the expected version and reflects a confirmed reload', async () => {
    const view = render(<MemoryRouter><SystemSmsSettings /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'تغییر تنظیم ثبت تیکت' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره و تأیید' }))
    await waitFor(() => expect(version).toBe(1))
    const call = request.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(call[0]).toMatch(/\/sms\/ticketCreated$/)
    expect(JSON.parse(call[1].body)).toEqual({ enabled: true, version: 0, confirm: true })
    view.unmount(); render(<MemoryRouter><SystemSmsSettings /></MemoryRouter>)
    expect(await screen.findByText('روشن')).toBeTruthy()
  })
  it('keeps the failed save open and does not falsely display an enabled state', async () => {
    fail = true
    render(<MemoryRouter><SystemSmsSettings /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'تغییر تنظیم ثبت تیکت' }))
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'ذخیره و تأیید' }))
    expect((await screen.findByRole('alert')).textContent).toContain('تنظیم تغییر کرده')
    expect(enabled).toBe(false); expect(version).toBe(0)
    expect(screen.getByRole('button', { name: 'ذخیره و تأیید' })).toBeTruthy()
  })
})
