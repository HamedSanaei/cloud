import type { ProviderServerView } from './provider.interface.js'

export const managementActions = ['power_on', 'shutdown', 'power_off', 'reboot', 'reset', 'delete', 'resize', 'rebuild', 'reset_password', 'enable_rescue', 'disable_rescue', 'attach_iso', 'detach_iso', 'change_protection'] as const
export type ManagementAction = typeof managementActions[number]
export type ServerOperationAction = ManagementAction | 'replace_primary_ipv4'
export interface PrimaryIpv4 {
  id: number
  address: string
  location: string
  serverId: string | null
  autoDelete: boolean
  protected: boolean
  blocked: boolean
  customReverseDns: boolean
}
export interface PrimaryIpv4Provider {
  read(server: string, id: number): Promise<PrimaryIpv4 | null>
  findReplacement(server: string, operationId: string): Promise<PrimaryIpv4 | null>
  create(server: string, location: string, operationId: string): Promise<{ ipId: number; actionId: number | null }>
  assign(server: string, id: number): Promise<number>
  unassign(server: string, id: number): Promise<number>
  remove(server: string, id: number): Promise<void>
  observe(server: string, actionId: number, target: { type: 'server' | 'primary_ip'; id: number }, command: string): Promise<ManagementObservation['status']>
}
export type ServerAccessBlock = 'operation_pending' | 'deletion_pending' | 'server_deleted' | 'server_not_ready'
  | 'provider_unavailable' | 'provider_access_denied' | 'unsupported' | 'rebuild_protected'
export interface ServerAccessEligibility {
  rebuild: ServerAccessBlock | null
  resetPassword: ServerAccessBlock | null
}
export interface ManagementResult { actionId: number; command?: string; secret?: string }
export interface ManagementObservation { status: 'running' | 'success' | 'error'; command: string; errorCode?: string }
export interface ServerActionEvidence extends ManagementObservation { id: number; startedAt: string; finishedAt: string | null }
export interface ServerMetrics { start: string; end: string; step: number; series: Record<string, Array<[number, number | null]>> }
export interface CustomerProvider {
  primaryIpv4?: PrimaryIpv4Provider
  inspect(id: string): Promise<ProviderServerView>
  submit(id: string, action: ManagementAction, input: Record<string, unknown>): Promise<ManagementResult>
  observe(id: string, actionId: number): Promise<ManagementObservation>
  actionHistory(id: string, actionId?: number): Promise<ServerActionEvidence[]>
  absent(id: string): Promise<boolean>
  metrics(id: string, start: Date, end: Date, step: number): Promise<ServerMetrics>
  images(id: string): Promise<Array<{ id: string; name: string; architecture: string; minDiskGb: number }>>
  resizeOptions(id: string): Promise<Array<{ type: string; architecture: string; storageType: string; vcpu: number; memoryMb: number; diskGb: number; available: boolean }>>
  console(id: string): Promise<{ url: string; password: string }>
}
