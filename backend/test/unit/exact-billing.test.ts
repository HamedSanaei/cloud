import { describe, expect, it } from 'vitest'
import { addInterval } from '../../src/modules/subscriptions/service.js'
import { computePriceFromRules } from '../../src/modules/pricing/service.js'
import { offeredPeriods } from '../../src/modules/pricing/periods.js'

describe('exact ledger and UTC prepaid calendar', () => {
  it.each([
    ['2027-01-31T22:15:42.123Z', '2027-02-28T22:15:42.123Z'],
    ['2028-01-31T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
    ['2026-12-31T20:30:00.000Z', '2027-01-31T20:30:00.000Z'],
    ['2026-03-29T01:30:00.000Z', '2026-04-29T01:30:00.000Z'],
    ['2026-03-31T12:00:00.000Z', '2026-04-30T12:00:00.000Z'],
  ])('clamps one UTC calendar month from %s', (start, end) => {
    expect(addInterval(new Date(start), 'MONTHLY').toISOString()).toBe(end)
    expect(new Date(start).toISOString()).toBe(start)
  })
  it('anchors successive monthly periods to the prior clamped boundary and keeps an exact UTC hour', () => {
    const january = new Date('2026-01-31T23:30:00Z')
    const february = addInterval(january, 'MONTHLY')
    expect(addInterval(february, 'MONTHLY').toISOString()).toBe('2026-03-28T23:30:00.000Z')
    expect(addInterval(january, 'HOURLY').toISOString()).toBe('2026-02-01T00:30:00.000Z')
  })
  it('preserves a grandfathered daily 24-hour interval over local DST', () => {
    const date = new Date('2026-03-29T01:30:00Z')
    expect(addInterval(date, 'DAILY').getTime() - date.getTime()).toBe(86400000)
    expect(offeredPeriods([{ billingCycle: 'hourly', amount: '0.0055' }, { billingCycle: 'daily', amount: '1' }])).toEqual(['hourly'])
  })
  it('ignores cosmetic rounding and preserves fractional cents until final IRR conversion', () => {
    const rules = { markupPercent: '25', markupFixedRial: 0, taxPercent: '10', roundingToRial: 1000, enabled: true }
    const amount = computePriceFromRules({ providerCurrency: 'EUR', providerAmountCents: 0.55, fxRate: '620001.123456', rules })
    expect(amount.subtotalRial).toBe(4262)
    expect(amount.totalRial).toBe(4688)
    expect(amount.subtotalRial + amount.taxRial).toBe(amount.totalRial)
    expect(computePriceFromRules({ providerCurrency: 'EUR', providerAmountCents: 0.55, fxRate: '620001.123456', rules: { ...rules, roundingToRial: 100000 } })).toEqual(amount)
  })
})
