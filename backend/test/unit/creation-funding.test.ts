import { describe, expect, it } from 'vitest'
import { minimumCreationBalanceRial } from '../../src/modules/billing/creation-funding.js'

describe('one week of purchase funding (integer rials)', () => {
  it('requires 168 hours, 7 days, or a full prepaid month', () => {
    expect(minimumCreationBalanceRial(36000, 'HOURLY')).toBe(6048000)
    expect(minimumCreationBalanceRial(864000, 'DAILY')).toBe(6048000)
    expect(minimumCreationBalanceRial(25920000, 'MONTHLY')).toBe(25920000)
  })
  it.each([[0, 'HOURLY'], [-1, 'DAILY'], [0.1, 'MONTHLY'], [1, 'unknown'], [Number.MAX_SAFE_INTEGER, 'HOURLY']])('rejects invalid or overflowing input', (price, interval) => {
    expect(() => minimumCreationBalanceRial(Number(price), String(interval))).toThrow()
  })
})
