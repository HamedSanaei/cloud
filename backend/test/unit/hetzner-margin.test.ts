import { expect, it } from 'vitest'
import { markupTomanToRial } from '../../src/contracts/hetzner-margin.js'
import { marginInput } from '../../src/modules/pricing/hetzner-margin.js'

it('accepts zero, preserves four percentage decimals and converts fractional toman exactly', () => {
  expect(markupTomanToRial('0')).toBe(0)
  expect(markupTomanToRial('123456.7')).toBe(1234567)
  const base = { markupFixedRial: 0, version: '2026-11-18T02:00:00.000Z' }
  for (const markupPercent of ['0', '15.1234', '1000.0000']) {
    expect(marginInput.parse({ ...base, markupPercent }).markupPercent).toBe(markupPercent)
  }
  for (const markupPercent of ['-1', '15.12345', '1000.0001', 'Infinity', '1e2']) {
    expect(marginInput.safeParse({ ...base, markupPercent }).success).toBe(false)
  }
  for (const toman of ['', '-1', '0.01', 'NaN', '1000000.1']) expect(markupTomanToRial(toman)).toBeNull()
  expect(marginInput.safeParse({ ...base, markupPercent: '0', markupFixedRial: 10_000_001 }).success).toBe(false)
})
