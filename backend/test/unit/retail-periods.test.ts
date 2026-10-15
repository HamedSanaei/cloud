import { describe, expect, it } from 'vitest'
import { exactProviderCents, offeredPeriods, retailBilling } from '../../src/modules/pricing/periods.js'
import { computePriceFromRules } from '../../src/modules/pricing/service.js'

const hourly = { billingCycle: 'hourly', amount: '0.0055' }
const monthly = { billingCycle: '1_MONTH', contractTerm: '1_MONTH', amountCents: 1450 }
const rules = { markupPercent: '25', markupFixedRial: 0, taxPercent: '0', roundingToRial: 1, enabled: true }

describe('retail periods', () => {
  it('keeps sub-cent cloud pricing exact through FX and markup', () => {
    const billing = retailBilling([hourly], 'hourly')
    const price = computePriceFromRules({ providerCurrency: 'EUR', providerAmountCents: billing.pricing.amountCents, fxRate: '620000', rules })
    expect(price.totalRial).toBe(4262)
    expect(price.providerAmountCents).toBe(0.55)
    expect(billing.native).toEqual(hourly)
  })

  it('prices daily cloud as 24 native hours without changing the provider billing contract', () => {
    const billing = retailBilling([hourly], 'daily')
    const price = computePriceFromRules({ providerCurrency: 'EUR', providerAmountCents: billing.pricing.amountCents, fxRate: '620000', rules })
    expect(price.totalRial).toBe(102300)
    expect(billing.interval).toBe('DAILY')
    expect(billing.native.billingCycle).toBe('hourly')
    expect(billing.pricing.amountCents).toBe(13.2)
  })

  it('does not advertise hourly or daily periods for a prepaid monthly VPS', () => {
    expect(offeredPeriods([monthly])).toEqual(['monthly'])
    expect(() => retailBilling([monthly], 'daily')).toThrow()
    expect(() => retailBilling([monthly], 'hourly')).toThrow()
  })

  it('does not sell a long commitment as cancellable monthly service', () => {
    expect(offeredPeriods([{ billingCycle: 'monthly', contractTerm: 12, amountCents: 1000 }])).toEqual([])
  })

  it('prefers an explicitly priced native daily option over derived hourly pricing', () => {
    const daily = { billingCycle: 'daily', amount: '0.10' }
    const billing = retailBilling([hourly, daily], 'daily')
    expect(billing.native).toEqual(daily)
    expect(billing.pricing.amountCents).toBe(10)
  })

  it('rejects unknown, negative, zero and over-precision provider prices instead of inventing prices', () => {
    for (const amount of ['-1', '0', 'NaN', '0.000000001']) {
      expect(() => exactProviderCents({ billingCycle: 'hourly', amount })).toThrow()
    }
    expect(offeredPeriods([{ billingCycle: 'unknown', amount: '10' }])).toEqual([])
  })
})
