import { describe, expect, it } from 'vitest'
import { canTransition } from '../../src/modules/orders/service.js'
import type { OrderStatus } from '../../src/modules/orders/service.js'

const ALL: OrderStatus[] = [
  'draft',
  'quoted',
  'awaiting_payment',
  'paid',
  'queued',
  'provisioning',
  'active',
  'failed',
  'cancelled',
  'requires_review',
  'refunded',
]

describe('order state machine', () => {
  it('follows the happy path paid -> queued -> provisioning -> active', () => {
    expect(canTransition('paid', 'queued')).toBe(true)
    expect(canTransition('queued', 'provisioning')).toBe(true)
    expect(canTransition('provisioning', 'active')).toBe(true)
  })

  it('allows awaiting_payment -> paid and awaiting_payment -> cancelled', () => {
    expect(canTransition('awaiting_payment', 'paid')).toBe(true)
    expect(canTransition('awaiting_payment', 'cancelled')).toBe(true)
  })

  it('never skips states or jumps arbitrarily', () => {
    expect(canTransition('paid', 'active')).toBe(false) // must pass queued/provisioning
    expect(canTransition('awaiting_payment', 'active')).toBe(false)
    expect(canTransition('draft', 'paid')).toBe(false)
    expect(canTransition('active', 'cancelled')).toBe(false)
    expect(canTransition('cancelled', 'paid')).toBe(false)
    expect(canTransition('refunded', 'active')).toBe(false)
  })

  it('routes ambiguous provider results to requires_review', () => {
    expect(canTransition('provisioning', 'requires_review')).toBe(true)
    expect(canTransition('requires_review', 'active')).toBe(true)
    expect(canTransition('requires_review', 'refunded')).toBe(true)
    expect(canTransition('requires_review', 'failed')).toBe(true)
  })

  it('terminals have no outgoing transitions', () => {
    for (const status of ['cancelled', 'refunded'] as OrderStatus[]) {
      for (const target of ALL) {
        expect(canTransition(status, target)).toBe(false)
      }
    }
  })
})