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

export function formatFaDateTime(value: string): string {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '—'
  let timeZone = 'Asia/Tehran'
  try {
    const saved = localStorage.getItem('cloud-timezone')
    timeZone = saved === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : saved || timeZone
    new Intl.DateTimeFormat('fa-IR', { timeZone })
  } catch {
    timeZone = 'Asia/Tehran'
  }
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).format(date)
}
