import { describe, expect, it } from 'vitest'
import { computePriceFromRules } from '../../src/modules/pricing/service.js'

const baseRules = {
  markupPercent: '25',
  markupFixedRial: 0,
  taxPercent: '0',
  roundingToRial: 1_000,
  enabled: true,
}

describe('price engine', () => {
  it('computes EUR -> IRR with markup and rounding', () => {
    const snap = computePriceFromRules({
      providerCurrency: 'EUR',
      providerAmountCents: 1450, // 14.50 EUR
      fxRate: '620000',
      rules: baseRules,
    })
    expect(snap.providerAmountCents).toBe(1450)
    expect(snap.fxRate).toBe('620000')
    // 1450 * 620000 / 100 = 8,990,000 rials; +25% = 11,237,500; round to 1000
    expect(snap.subtotalRial).toBe(11_237_500)
    expect(snap.totalRial).toBe(11_238_000)
  })

  it('applies fixed markup in addition to percent markup', () => {
    const snap = computePriceFromRules({
      providerCurrency: 'EUR',
      providerAmountCents: 1000, // 10 EUR
      fxRate: '100000',
      rules: { ...baseRules, markupFixedRial: 500_000 },
    })
    // 10 EUR -> 1,000,000 rials + 500,000 fixed = 1,500,000; +25% = 1,875,000
    expect(snap.subtotalRial).toBe(1_875_000)
    expect(snap.totalRial).toBe(1_875_000)
  })

  it('applies tax after markup', () => {
    const snap = computePriceFromRules({
      providerCurrency: 'EUR',
      providerAmountCents: 1000,
      fxRate: '100000',
      rules: { ...baseRules, taxPercent: '10' },
    })
    // 1,000,000 + 25% = 1,250,000; tax 10% = 125,000; total = 1,375,000
    expect(snap.subtotalRial).toBe(1_250_000)
    expect(snap.taxRial).toBe(125_000)
    expect(snap.totalRial).toBe(1_375_000)
  })

  it('produces a complete immutable snapshot', () => {
    const snap = computePriceFromRules({
      providerCurrency: 'EUR',
      providerAmountCents: 825,
      fxRate: '620000',
      rules: baseRules,
    })
    expect(snap).toEqual({
      providerCurrency: 'EUR',
      providerAmountCents: 825,
      fxRate: '620000',
      markupPercent: '25',
      markupFixedRial: 0,
      taxPercent: '0',
      subtotalRial: 6_393_750, // 825*620000/100 = 5,115,000; +25% markup = 6,393,750
      taxRial: 0,
      totalRial: 6_394_000, // rounded to 1000
    })
    // A snapshot is a plain value object: changing inputs later must not
    // change the snapshot (no shared mutable state).
    const snap2 = computePriceFromRules({
      providerCurrency: 'EUR',
      providerAmountCents: 825,
      fxRate: '700000',
      rules: baseRules,
    })
    expect(snap2.totalRial).not.toBe(snap.totalRial)
    expect(snap.totalRial).toBe(6_394_000)
  })

  it('rejects disabled pricing', () => {
    expect(() =>
      computePriceFromRules({
        providerCurrency: 'EUR',
        providerAmountCents: 1000,
        fxRate: '100000',
        rules: { ...baseRules, enabled: false },
      }),
    ).toThrow()
  })

  it('rejects non-positive provider price', () => {
    expect(() =>
      computePriceFromRules({
        providerCurrency: 'EUR',
        providerAmountCents: 0,
        fxRate: '100000',
        rules: baseRules,
      }),
    ).toThrow()
  })
})