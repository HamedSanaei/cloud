/**
 * Billing classification — the platform's single source of truth for whether
 * a provider billing option is genuinely month-to-month.
 *
 * Safety contract:
 *  - Classification is derived ONLY from provider-returned evidence
 *    (billingCycle / contractTerm / periodMonths). There is deliberately NO
 *    `monthly` input field: the legacy mock-only `monthly: true` flag is not
 *    evidence and is never consulted.
 *  - Unrecognized provider values produce UNKNOWN, never an assumed "monthly".
 *  - Billing cycle and contract term are classified independently:
 *    monthly invoicing with a 12-month commitment is
 *    MONTHLY_BILLING_LONG_TERM_COMMITMENT, NOT month-to-month.
 */
import type { BillingClassification, CommercialType, ProviderBillingOption } from './provider.interface.js'

/**
 * Parse a provider billing-cycle value into months. Returns null unless the
 * value provably means "every N months". Recognized spellings are literal
 * provider values ('monthly', '1M', '1 month', '1_month', '12', ...) — an
 * unrecognized enum is NOT mapped to anything.
 */
export function parseBillingPeriodMonths(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.round(value)
  if (typeof value !== 'string') return null
  const s = value.trim().toLowerCase()
  if (s === 'monthly' || s === '1m' || s === '1 month' || s === '1month' || s === '1_month') return 1
  const n = Number(s)
  if (Number.isFinite(n) && n >= 1 && Number.isInteger(n)) return n
  return null
}

/**
 * Parse a provider contract-term value into months (0 = no commitment).
 * Recognized: numbers and spellings like '1M', '12M', '12 months', '0'.
 */
export function parseContractTermMonths(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value)
  if (typeof value !== 'string') return null
  const s = value.trim().toLowerCase()
  const m = /^(\d+)[_\s]*m(?:onth)?s?$/.exec(s)
  if (m) return Number(m[1])
  const n = Number(s)
  if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n
  return null
}

export function classifyBillingOption(input: {
  billingCycle?: string
  contractTerm?: string | number
  periodMonths?: number
  source: string
}): BillingClassification {
  const cycle = input.billingCycle ?? ''
  const period =
    input.periodMonths !== undefined && Number.isFinite(input.periodMonths) && input.periodMonths >= 1
      ? Math.round(input.periodMonths)
      : parseBillingPeriodMonths(cycle)
  const rawTerm = input.contractTerm
  const termMonths = rawTerm === undefined || rawTerm === null ? null : parseContractTermMonths(rawTerm)

  if (period === null) {
    return {
      classification: 'UNKNOWN',
      customerBillingInterval: null,
      monthToMonth: null,
      eligibilityReason: `billing cycle '${cycle}' is not provably a period in months`,
      source: input.source,
    }
  }
  if (period !== 1) {
    return {
      classification: 'NON_MONTHLY_BILLING',
      customerBillingInterval: null,
      monthToMonth: null,
      eligibilityReason: `billing cycle '${cycle}' invoices every ${period} month(s), not monthly`,
      source: input.source,
    }
  }
  // Monthly invoicing proven. The contract commitment decides month-to-month
  // vs monthly-billing-with-longer-commitment.
  if (termMonths === null) {
    return {
      classification: 'UNKNOWN',
      customerBillingInterval: 'MONTHLY',
      monthToMonth: null,
      eligibilityReason: `monthly invoicing proven (billing cycle '${cycle}') but contract term '${String(rawTerm)}' is not provable`,
      source: input.source,
    }
  }
  if (termMonths <= 1) {
    return {
      classification: 'MONTH_TO_MONTH',
      customerBillingInterval: 'MONTHLY',
      monthToMonth: true,
      eligibilityReason: `billing cycle '${cycle}' invoices monthly with a ${termMonths}-month contract commitment`,
      source: input.source,
    }
  }
  return {
    classification: 'MONTHLY_BILLING_LONG_TERM_COMMITMENT',
    customerBillingInterval: 'MONTHLY',
    monthToMonth: false,
    eligibilityReason: `billing cycle '${cycle}' invoices monthly with a ${termMonths}-month contract commitment`,
    source: input.source,
  }
}

/** Batch-classify an adapter's raw options, attaching classifier output. */
export function classifyBillingOptions(
  source: string,
  options: ProviderBillingOption[],
): ProviderBillingOption[] {
  return options.map((o) => {
    const c = classifyBillingOption({
      billingCycle: o.billingCycle,
      contractTerm: o.contractTerm,
      periodMonths: o.periodMonths,
      source,
    })
    return {
      ...o,
      classification: c.classification,
      customerBillingInterval: c.customerBillingInterval,
      monthToMonth: c.monthToMonth,
      eligibilityReason: c.eligibilityReason,
      source: c.source,
    }
  })
}

export function isMonthlyInvoicing(classification: CommercialType | undefined): boolean {
  return classification === 'MONTH_TO_MONTH' || classification === 'MONTHLY_BILLING_LONG_TERM_COMMITMENT'
}

/** Convenience for output/columns. */
export function commercialTypeLabel(classification: CommercialType | undefined): string {
  switch (classification) {
    case 'MONTH_TO_MONTH':
      return 'MONTH-TO-MONTH'
    case 'MONTHLY_BILLING_LONG_TERM_COMMITMENT':
      return 'MONTHLY BILLING / LONGER CONTRACT'
    case 'NON_MONTHLY_BILLING':
      return 'NON-MONTHLY BILLING'
    default:
      return 'UNKNOWN'
  }
}