import { describe, expect, it } from 'vitest'
import { PARSGREEN_TEMPLATES } from '../../src/modules/auth/parsgreen-templates.js'

describe('ParsGreen operator-approved notification catalog', () => {
  it('records all 20 unique message samples and their panel approval state', () => {
    const templates = Object.values(PARSGREEN_TEMPLATES)
    expect(templates).toHaveLength(20)
    expect(templates.filter((entry) => entry.approval === 'rejected')).toHaveLength(2)
    expect(templates.filter((entry) => entry.approval === 'unknown')).toHaveLength(1)
    expect(PARSGREEN_TEMPLATES.ticketReplied.approval).toBe('rejected')
    expect(PARSGREEN_TEMPLATES.incidentDetected.approval).toBe('rejected')
    expect(PARSGREEN_TEMPLATES.passwordChanged.approval).toBe('unknown')
    expect(templates.every((entry) => entry.sample.startsWith('پارس سرور:') && entry.sample.includes('parserver.ir'))).toBe(true)
    expect(new Set(templates.map((entry) => entry.sample)).size).toBe(20)
  })

  it('keeps sample values separate from approval of dynamic SMS delivery', () => {
    expect(PARSGREEN_TEMPLATES.serverActivated.sample).toContain('192.0.2.20')
    expect(PARSGREEN_TEMPLATES.ticketReplied.sample).toContain('%%')
    expect(PARSGREEN_TEMPLATES.ticketClosed.variables).toContain('ticketNumber')
  })
})
