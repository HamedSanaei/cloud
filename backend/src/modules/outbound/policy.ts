import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import type { HttpIntegration, NetworkCategory } from '../../contracts/outbound.js'

export class OutboundError extends Error {
  constructor(readonly category: NetworkCategory) { super(`Outbound connection failed (${category})`); this.name = 'OutboundError' }
}
export async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new OutboundError('timeout'))
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', onAbort) }
}
// No suffix matching, configurable test URL, HTTP, redirect or nonstandard port.
const hosts: Record<Exclude<HttpIntegration, 'google'>, string> = {
  hetzner: 'api.hetzner.cloud', leaseweb: 'api.leaseweb.com', parsgreen: 'login.parsgreen.com',
  tabapay: 'api.tabapay.ir', abantether: 'api.abantether.com',
}
export const googleTargets = {
  token: 'https://oauth2.googleapis.com/token',
  tokenProbe: 'https://oauth2.googleapis.com/tokeninfo',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
} as const
const approvedGoogleTargets = new Set<string>(Object.values(googleTargets))
export function approvedTarget(integration: HttpIntegration, input: string | URL): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new OutboundError('policy') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      (integration === 'google' ? !approvedGoogleTargets.has(url.href) : url.hostname !== hosts[integration])) throw new OutboundError('policy')
  return url
}
export function approveSmtpTarget(host: string, port: number, secure: boolean) {
  if (host !== 'smtp.resend.com' || !(secure ? [465, 2465] : [587, 2587]).includes(port)) throw new OutboundError('policy')
}
const hetznerConsoleHosts = new Set(['console.hetzner.cloud', 'web-console.hetzner.cloud'])
export function approvedHetznerConsole(input: string): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new OutboundError('policy') }
  if (url.protocol !== 'wss:' || !hetznerConsoleHosts.has(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw new OutboundError('policy')
  }
  return url
}
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}
export async function publicAddresses(host: string) {
  const rows = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }]
    : await lookup(host, { all: true, verbatim: true })
  // Reject mixed answers, mapped IPv6 and special-use ranges before opening a socket.
  if (!rows.length || rows.some(row => !publicAddress(row.address))) throw new OutboundError('policy')
  return rows
}
export const testTargets: Record<Exclude<HttpIntegration, 'google'>, { url: string; method: 'GET' | 'HEAD' }> = {
  hetzner: { url: 'https://api.hetzner.cloud/v1/locations', method: 'GET' },
  leaseweb: { url: 'https://api.leaseweb.com/publicCloud/v1/regions', method: 'GET' },
  parsgreen: { url: 'https://login.parsgreen.com/Api/SendSMS.asmx', method: 'HEAD' },
  tabapay: { url: 'https://api.tabapay.ir', method: 'HEAD' },
  abantether: { url: 'https://api.abantether.com/api/v1/manager/otc/ticker?coin=USDT', method: 'GET' },
}
export function errorCategory(error: unknown): NetworkCategory {
  let current = error
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof OutboundError) return current.category
    const e = current as { code?: string; name?: string; message?: string; cause?: unknown }
    const code = e.code ?? '', message = e.message ?? ''
    // Inspect known transport phrases only; never retain a raw error or credential.
    if (message.includes('Proxy response (407)') || message.includes('Socks5 Authentication failed')) return 'authentication'
    if (code === 'EAUTH') return 'authentication'
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || /TIMEOUT|TIMEDOUT/.test(code)) return 'timeout'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
    if (/CERT|TLS|SSL/.test(code)) return 'tls'
    current = e.cause
  }
  return 'unreachable'
}
