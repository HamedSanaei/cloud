import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AdminDatacenters } from '../src/admin/AdminDatacenters'

describe('admin datacenter controls', () => {
  it('persists the selected sales switch and refreshes its status', async () => {
    let enabled = true
    const writes: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push(body); enabled = body.enabled }
      return new Response(JSON.stringify({ data: [{ id: 'hetzner', name: 'Hetzner', enabled, configured: true }] }), { headers: { 'content-type': 'application/json' } })
    }))
    const user = userEvent.setup()
    render(<MemoryRouter><AdminDatacenters /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'غیرفعال کردن خرید Hetzner' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'فعال کردن خرید Hetzner' })).toBeTruthy())
    expect(writes).toEqual([{ enabled: false }])
  })
})
