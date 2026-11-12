import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HetznerInventoryPanel } from '../src/admin/HetznerInventoryPanel'

vi.mock('../src/hooks/useApiQuery', () => ({
  useApiQuery: () => ({
    loading: false, error: null, refetch: vi.fn(),
    data: {
      accounts: 2, syncedAt: '2026-11-12T01:00:00Z',
      items: [
        { providerServerId: 'main:101', accountId: 'main', name: 'site-vm', status: 'active', ipv4: '192.0.2.10',
          vcpu: 2, memoryMb: 4096, diskGb: 40, location: 'fsn1', source: 'website',
          websiteServerId: '11111111-1111-4111-8111-111111111111' },
        { providerServerId: 'other:202', accountId: 'other', name: 'external-vm', status: 'suspended', ipv4: '192.0.2.11',
          vcpu: 4, memoryMb: 8192, diskGb: 80, location: 'hel1', source: 'hetzner',
          websiteServerId: null },
      ],
    },
  }),
}))

describe('admin all-project Hetzner inventory', () => {
  it('distinguishes website-linked and manually created Hetzner machines', () => {
    render(<MemoryRouter><HetznerInventoryPanel /></MemoryRouter>)
    expect(screen.getByText('site-vm')).toBeTruthy()
    expect(screen.getByText('external-vm')).toBeTruthy()
    expect(screen.getByText('هتزنر مستقیم · بدون مالک سایت')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'site-vm' }).getAttribute('href')).toBe('/admin/servers/11111111-1111-4111-8111-111111111111')
    expect(screen.queryByRole('link', { name: 'external-vm' })).toBeNull()
  })
})
