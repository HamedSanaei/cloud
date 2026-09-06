const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

export function toFaDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => FA_DIGITS[Number(digit)])
}

export function formatFaNumber(value: number): string {
  return toFaDigits(new Intl.NumberFormat('en-US').format(value))
}

export function formatToman(value: number): string {
  if (!Number.isFinite(value)) return '۰ تومان'
  return `${formatFaNumber(value)} تومان`
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '۰'
  return toFaDigits(value)
}
