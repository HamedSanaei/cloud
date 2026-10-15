import { ValidationError } from '../../lib/errors.js'
import type { ProviderBillingOption } from '../providers/provider.interface.js'
import { classifyBillingOption } from '../providers/billing.js'

export type RetailPeriod = 'hourly' | 'daily' | 'monthly'
export type RetailInterval = 'HOURLY' | 'DAILY' | 'MONTHLY'

export function nativePeriod(option: ProviderBillingOption): RetailPeriod | null {
  const cycle = option.billingCycle.trim().toLowerCase()
  if (['hourly', 'hour', '1h', '1_hour'].includes(cycle)) return 'hourly'
  if (['daily', 'day', '1d', '1_day'].includes(cycle)) return 'daily'
  const classification = classifyBillingOption({ ...option, source: option.source ?? 'provider-api' })
  return classification.classification === 'MONTH_TO_MONTH' ? 'monthly' : null
}

/** Exact integer representation; provider currency supports eight decimal places. */
function scaledDecimal(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match || (match[2]?.length ?? 0) > scale) throw new ValidationError('قیمت سرویس‌دهنده نامعتبر است')
  return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt((match[2] ?? '').padEnd(scale, '0') || '0')
}

export function exactProviderCents(option: ProviderBillingOption, multiplier = 1): number {
  const scaled = option.amount !== undefined
    ? scaledDecimal(option.amount, 8)
    : option.amountCents !== undefined
      ? scaledDecimal(String(option.amountCents), 6)
      : 0n
  const total = scaled * BigInt(multiplier)
  if (total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError('محصول انتخابی قیمت معتبری ندارد')
  return Number(total) / 1_000_000
}

export function retailBilling(options: ProviderBillingOption[], period: RetailPeriod) {
  const native = options.find((option) => nativePeriod(option) === period)
    ?? (period === 'daily' ? options.find((option) => nativePeriod(option) === 'hourly') : undefined)
  if (!native) throw new ValidationError('دوره پرداخت انتخابی برای این سرویس موجود نیست')
  const multiplier = period === 'daily' && nativePeriod(native) === 'hourly' ? 24 : 1
  const amountCents = exactProviderCents(native, multiplier)
  return {
    native,
    pricing: { ...native, amount: undefined, amountCents },
    interval: ({ hourly: 'HOURLY', daily: 'DAILY', monthly: 'MONTHLY' } as const)[period],
  }
}

export function offeredPeriods(options: ProviderBillingOption[]): RetailPeriod[] {
  const periods = new Set<RetailPeriod>()
  for (const option of options) {
    const period = nativePeriod(option)
    if (!period) continue
    try {
      exactProviderCents(option)
      periods.add(period)
      if (period === 'hourly') periods.add('daily')
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
    }
  }
  return (['hourly', 'daily', 'monthly'] as const).filter((period) => periods.has(period))
}

/** Fractional cents -> rials, with decimal scaling and no binary-float multiplication. */
export function providerCentsToRial(cents: number, fxRate: string): number {
  const amount = scaledDecimal(String(cents), 6)
  const fx = scaledDecimal(fxRate, 6)
  const result = amount * fx / 100_000_000_000_000n
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError('مبلغ سفارش بیش از حد مجاز است')
  return Number(result)
}
