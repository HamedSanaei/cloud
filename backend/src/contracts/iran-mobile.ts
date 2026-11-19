export const invalidIranMobile = 'شماره همراه ایرانی را کامل وارد کنید، مانند ۰۹۱۲۳۴۵۶۷۸۹.'

export function normalizeIranMobile(value: string): string | null {
  if (value.length > 64) return null
  const ascii = value.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) & 15)).replace(/[\s()-]/g, '')
  if (/^09\d{9}$/.test(ascii)) return `+98${ascii.slice(1)}`
  if (/^989\d{9}$/.test(ascii)) return `+${ascii}`
  return /^\+989\d{9}$/.test(ascii) ? ascii : null
}
