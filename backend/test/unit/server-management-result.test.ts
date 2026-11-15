import { describe, expect, it } from 'vitest'
import { managementDto } from '../../src/modules/servers/management.js'

describe('observed resize result DTO', () => {
  const operation = { id: 'fixture-resize', kind: 'server_management', provider: 'hetzner', action: 'resize', status: 'succeeded',
    createdAt: new Date('2026-11-16T10:00:00Z'), updatedAt: new Date('2026-11-16T10:01:00Z'), completedAt: new Date('2026-11-16T10:01:00Z'),
    responseMetadata: { actionId: 81, resize: { powerBefore: 'suspended', powerAfter: 'active', startedAfterResize: true } },
  } as Parameters<typeof managementDto>[0]
  it('exposes persisted observations on a confirmed resize', () => {
    expect(managementDto(operation)).toMatchObject({ status: 'confirmed', resize: { powerBefore: 'suspended', powerAfter: 'active', startedAfterResize: true } })
  })
  it('never infers startup for legacy operations without observations or unfinished operations', () => {
    expect(managementDto({ ...operation, responseMetadata: null })).not.toHaveProperty('resize')
    expect(managementDto({ ...operation, status: 'running', completedAt: null })).not.toHaveProperty('resize')
  })
})
