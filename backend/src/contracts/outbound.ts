/** Fixed integration IDs only. Browser input never chooses a destination URL. */
export const outboundIntegrations = ['hetzner', 'leaseweb', 'parsgreen', 'tabapay', 'abantether'] as const
export type OutboundIntegration = typeof outboundIntegrations[number]
export type ProxyType = 'socks5' | 'http' | 'https'
export type FailurePolicy = 'closed' | 'read-only-direct'
export interface ProxyProfile {
  id: string; name: string; type: ProxyType; host: string; port: number; enabled: boolean; timeoutMs: number
  username: string; password: string
}
export interface OutboundRoute { enabled: boolean; profileId: string | null; failurePolicy: FailurePolicy }
export interface OutboundState { revision: string; profiles: ProxyProfile[]; routes: Partial<Record<OutboundIntegration, OutboundRoute>> }
export type PublicProxyProfile = Omit<ProxyProfile, 'username' | 'password'> & { authenticated: boolean }
export interface RouteReport { route: 'direct' | 'proxy' | 'direct-fallback' | 'blocked'; profileId: string | null }
export type NetworkCategory = 'none' | 'policy' | 'configuration' | 'timeout' | 'authentication' | 'dns' | 'tls' | 'unreachable' | 'upstream'
export interface OutboundConsoleHealth extends RouteReport {
  category: NetworkCategory; latencyMs: number; checkedAt: string; revision: string
}
export interface OutboundTestResult extends RouteReport {
  integration: OutboundIntegration; ok: boolean; reachable: boolean; category: NetworkCategory; latencyMs: number
  httpStatus?: number; testedAt: string; lastSuccessAt: string | null; revision: string
}
export interface OutboundStatus {
  revision: string; profiles: Array<PublicProxyProfile & { lastTest: OutboundTestResult | null }>
  integrations: Array<{ id: OutboundIntegration; route: OutboundRoute; active: RouteReport; lastTest: OutboundTestResult | null }>
  hetznerConsole: { latest: OutboundConsoleHealth | null; lastFailure: OutboundConsoleHealth | null }
}
