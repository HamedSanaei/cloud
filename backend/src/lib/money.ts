/**
 * Money helpers. ALL money is integer math:
 *  - Customer money: IRR in rials (integer).
 *  - API display: toman = rials / 10 (integer division, documented).
 *  - Provider money: integer cents in the provider currency.
 *
 * Never use floating point for money in this codebase.
 */

export const RIALS_PER_TOMAN = 10

export function tomanToRial(toman: number): number {
  return Math.trunc(toman) * RIALS_PER_TOMAN
}

/** Rials -> toman for display only (integer truncation, never used for math). */
export function rialToToman(rial: number): number {
  return Math.trunc(rial / RIALS_PER_TOMAN)
}

/** Integer-only multiply with rounding, avoiding float precision loss. */
export function multiplyByRate(amount: number, rate: string | number): number {
  // rate is a decimal string/number (e.g. "620000.5"). Multiply via BigInt on
  // scaled integers to stay exact.
  return applyRateDivisor(amount, rate, 1)
}

/**
 * amount * rate / divisor, exact integer math (rate scaled to 6 decimals).
 * Example: cents EUR -> rials with a EUR/IRR rate = applyRateDivisor(cents, rate, 100).
 */
export function applyRateDivisor(amount: number, rate: string | number, divisor: number): number {
  const rateStr = String(rate)
  const [intPart = '0', fracPart = ''] = rateStr.split('.')
  const frac = fracPart.slice(0, 6).padEnd(6, '0')
  const rateScaled = BigInt(intPart) * 1_000_000n + BigInt(frac)
  const amountBig = BigInt(Math.trunc(amount))
  const divisorBig = BigInt(Math.max(1, Math.trunc(divisor)))
  return Number((amountBig * rateScaled) / (divisorBig * 1_000_000n))
}

export function percentOf(amount: number, percent: string | number): number {
  // percent is a human percentage (e.g. 25 = 25%). Exact integer math:
  // p = percent * 100 (basis points); result = amount * p / 10000.
  const p = Math.round(Number(percent) * 100)
  return Math.trunc((amount * p) / 10_000)
}

export function roundTo(amount: number, unit: number): number {
  // Round half-up to the nearest multiple of `unit`, away from zero.
  // A non-zero amount must never collapse to 0 (school rounding):
  // roundTo(5, 1000) -> 1000, roundTo(-5, 1000) -> -1000.
  const u = BigInt(Math.max(1, Math.trunc(unit)))
  const a = BigInt(amount)
  const sign = a < 0n ? -1n : 1n
  const abs = a < 0n ? -a : a
  const half = u / 2n
  const down = (abs / u) * u
  const up = down + u
  let rounded = abs - down >= half ? up : down
  if (rounded === 0n && abs > 0n) rounded = u // never collapse a non-zero amount
  return Number(sign * rounded)
}

export function assertNonNegative(value: number, what = 'amount'): void {
  if (!Number.isInteger(value)) throw new Error(`${what} must be an integer, got ${value}`)
  if (value < 0) throw new Error(`${what} must be non-negative`)
}

export function toCents(euros: string | number): number {
  const s = String(euros)
  const [i = '0', f = ''] = s.split('.')
  const frac = f.slice(0, 2).padEnd(2, '0')
  return Number(BigInt(i) * 100n + BigInt(frac))
}

export function centsToEuros(cents: number): string {
  return (cents / 100).toFixed(2)
}