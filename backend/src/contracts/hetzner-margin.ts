export const maxHetznerMarkupPercent = 1_000
export const maxHetznerFixedRial = 10_000_000

/** A UI decimal with at most one tenth of a toman converts to exact integer IRR. */
export function markupTomanToRial(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d))?$/.exec(value)
  if (!match) return null
  const rial = Number(match[1]) * 10 + Number(match[2] ?? '0')
  return rial <= maxHetznerFixedRial ? rial : null
}
