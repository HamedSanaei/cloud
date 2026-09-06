/**
 * Billing classification safety tests.
 *
 * The classifier must NEVER rely on the legacy mock-only `monthly` flag, must
 * keep billing cycle independent from contract term, and must return UNKNOWN
 * for unprovable provider values instead of assuming monthly.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyBillingOption,
  classifyBillingOptions,
  parseBillingPeriodMonths,
  parseContractTermMonths,
} from '../../src/modules/providers/billing.js'
import type { ProviderBillingOption } from '../../src/modules/providers/provider.interface.js'
import { normalizeCatalog } from '../../src/modules/providers/leaseweb/live.js'

describe('billing classifier', () => {
  it('never treats the legacy mock-only `monthly: true` flag as evidence', () => {
    // An option carrying the old flag but an unprovable cycle stays UNKNOWN.
    const legacy = { billingCycle: 'weekly', contractTerm: 0 } as ProviderBillingOption & { monthly: true }
    const c = classifyBillingOption({
      billingCycle: legacy.billingCycle,
      contractTerm: legacy.contractTerm,
      source: 'leaseweb-api',
    })
    expect(c.classification).toBe('UNKNOWN')
    expect(c.monthToMonth).toBeNull()
    expect(c.customerBillingInterval).toBeNull()
  })

  it('keeps billing cycle and contract term independent', () => {
    // Monthly invoicing + 12-month commitment is NOT month-to-month.
    const longTerm = classifyBillingOption({ billingCycle: 'monthly', contractTerm: 12, source: 'leaseweb-api' })
    expect(longTerm.classification).toBe('MONTHLY_BILLING_LONG_TERM_COMMITMENT')
    expect(longTerm.monthToMonth).toBe(false)
    expect(longTerm.customerBillingInterval).toBe('MONTHLY')

    // 12-month invoicing cycle with no commitment is not monthly billing at all.
    const nonMonthly = classifyBillingOption({ billingCycle: '12', contractTerm: 0, source: 'leaseweb-api' })
    expect(nonMonthly.classification).toBe('NON_MONTHLY_BILLING')
    expect(nonMonthly.customerBillingInterval).toBeNull()
  })

  it('classifies true month-to-month only when provider values prove it', () => {
    const m2m = classifyBillingOption({ billingCycle: '1M', contractTerm: '1M', source: 'leaseweb-api' })
    expect(m2m.classification).toBe('MONTH_TO_MONTH')
    expect(m2m.monthToMonth).toBe(true)
    expect(m2m.eligibilityReason).toContain('monthly')
  })

  it('monthly billing with unprovable contract term is UNKNOWN, not month-to-month', () => {
    const c = classifyBillingOption({ billingCycle: 'monthly', contractTerm: 'CUSTOM', source: 'leaseweb-api' })
    expect(c.classification).toBe('UNKNOWN')
    expect(c.monthToMonth).toBeNull()
    expect(c.customerBillingInterval).toBe('MONTHLY')
  })

  it('unknown provider values produce UNKNOWN, never assumed monthly', () => {
    const c = classifyBillingOption({ billingCycle: 'semiannual', contractTerm: 'custom', source: 'leaseweb-api' })
    expect(c.classification).toBe('UNKNOWN')
    expect(c.eligibilityReason).toContain('not provably')
  })

  it('classifyBillingOptions attaches classification fields without touching provider values', () => {
    const options = classifyBillingOptions('leaseweb-api', [
      { billingCycle: 'monthly', contractTerm: 0 },
      { billingCycle: 'monthly', contractTerm: 12 },
    ])
    expect(options.map((o) => o.classification)).toEqual([
      'MONTH_TO_MONTH',
      'MONTHLY_BILLING_LONG_TERM_COMMITMENT',
    ])
    // Provider values pass through verbatim.
    expect(options[0]!.billingCycle).toBe('monthly')
    expect(options[0]!.contractTerm).toBe(0)
    expect(options[1]!.contractTerm).toBe(12)
    // The legacy mock-only flag is never synthesized.
    for (const o of options) {
      expect('monthly' in o).toBe(false)
    }
  })

  it('parsers are conservative', () => {
    expect(parseBillingPeriodMonths('monthly')).toBe(1)
    expect(parseBillingPeriodMonths('1M')).toBe(1)
    expect(parseBillingPeriodMonths('12')).toBe(12)
    expect(parseBillingPeriodMonths('semiannual')).toBeNull()
    expect(parseContractTermMonths('12M')).toBe(12)
    expect(parseContractTermMonths(0)).toBe(0)
    expect(parseContractTermMonths('CUSTOM')).toBeNull()
  })
})

describe('live adapter billing options (no fabrication)', () => {
  const rawWithIndependentLists = {
    products: [
      {
        id: 'VPS_TEST',
        name: 'Test VPS',
        configuration: {
          locations: ['AMS-01'],
          operatingSystems: ['ubuntu-24.04'],
          billingCycles: [{ id: '1M', price: { amount: 5.5, currency: 'EUR' } }, { id: '12M', price: { amount: 55.0, currency: 'EUR' } }],
          contractTerms: [{ id: '1M' }, { id: '12M' }],
        },
      },
    ],
  }

  it('does NOT generate a Cartesian product from independent cycle + term lists', () => {
    const { offers } = normalizeCatalog(rawWithIndependentLists)
    expect(offers).toHaveLength(1)
    // Cycle and term lists are independent here: the API does not prove any
    // pairing, so no billing option may be fabricated.
    expect(offers[0]!.billingOptions).toHaveLength(0)
  })

  it('exposes only proven pairings when a cycle embeds its own contract terms', () => {
    const raw = {
      products: [
        {
          id: 'VPS_TEST',
          name: 'Test VPS',
          configuration: {
            locations: ['AMS-01'],
            operatingSystems: ['ubuntu-24.04'],
            billingCycles: [
              { id: '1M', price: { amount: 5.5, currency: 'EUR' }, contractTerms: [{ id: '1M' }, { id: '12M' }] },
            ],
          },
        },
      ],
    }
    const { offers } = normalizeCatalog(raw)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.billingOptions).toHaveLength(2)
    for (const o of offers[0]!.billingOptions) {
      // The live adapter must never inject the mock-only monthly flag or a
      // hardcoded period.
      expect('monthly' in o).toBe(false)
      expect(o.periodMonths).toBeUndefined()
    }
    // Classification of these proven pairings happens centrally at sync:
    const classified = classifyBillingOptions('leaseweb-api', offers[0]!.billingOptions)
    expect(classified.map((o) => o.classification)).toEqual(['MONTH_TO_MONTH', 'MONTHLY_BILLING_LONG_TERM_COMMITMENT'])
  })
})