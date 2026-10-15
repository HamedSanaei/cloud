import { describe, expect, it } from 'vitest'
import {
  applyRateDivisor,
  centsToEuros,
  percentOf,
  rialToToman,
  roundTo,
  toCents,
  tomanToRial,
} from '../../src/lib/money.js'

describe('money (integer math only)', () => {
  it('converts EUR cents exactly (no floats)', () => {
    expect(toCents('14.50')).toBe(1450)
    expect(toCents('8.25')).toBe(825)
    expect(toCents('0.01')).toBe(1)
    expect(toCents('100')).toBe(10000)
    expect(centsToEuros(1450)).toBe('14.50')
  })

  it('converts cents -> rials exactly with a fractional FX rate', () => {
    // 1450 cents * 620000.5 / 100 = 8,990,007.25 -> trunc 8,990,007
    expect(applyRateDivisor(1450, '620000.5', 100)).toBe(8_990_007)
    // rate with 6 decimals
    expect(applyRateDivisor(1450, '620000.123456', 100)).toBe(8_990_001)
  })

  it('applies percentage markup exactly', () => {
    expect(percentOf(8_990_000, 25)).toBe(2_247_500) // 25%
    expect(percentOf(100_000, 10)).toBe(10_000)
    expect(percentOf(100_000, 0)).toBe(0)
    expect(percentOf(100_000, 2.5)).toBe(2_500)
  })

  it('rounds to the nearest unit', () => {
    expect(roundTo(11_237_500, 1_000)).toBe(11_238_000)
    expect(roundTo(11_236_400, 1_000)).toBe(11_236_000)
    expect(roundTo(5, 1_000)).toBe(1_000)
    expect(roundTo(-5, 1_000)).toBe(-1_000)
  })

  it('does not add a rial to exact prices and rounds odd units at the correct boundary', () => {
    expect(roundTo(4262, 1)).toBe(4262)
    expect(roundTo(10, 3)).toBe(9)
    expect(roundTo(11, 3)).toBe(12)
    expect(roundTo(-10, 3)).toBe(-9)
  })

  it('converts rials <-> toman for display only', () => {
    expect(tomanToRial(1_123_800)).toBe(11_238_000)
    expect(rialToToman(11_238_000)).toBe(1_123_800)
    expect(rialToToman(11_238_999)).toBe(1_123_899) // truncation, never rounding for money math
  })

})