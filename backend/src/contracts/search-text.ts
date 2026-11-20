export function toAsciiDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) & 15))
}

export function normalizeSearchText(value: string): string {
  return toAsciiDigits(value.trim()).toLowerCase()
}
