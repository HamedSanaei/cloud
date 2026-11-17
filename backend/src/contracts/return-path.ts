/** Retain purchase intent across auth without allowing an external redirect. */
export function safeReturnPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]|%5c|%0[ad]/i.test(value)) return fallback
  try { return new URL(value, 'https://app.invalid').origin === 'https://app.invalid' ? value : fallback } catch { return fallback }
}
