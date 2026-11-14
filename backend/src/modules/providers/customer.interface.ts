import type { ProviderServerView } from './provider.interface.js'

export const managementActions = ['power_on', 'shutdown', 'power_off', 'reboot', 'reset', 'delete', 'resize', 'rebuild', 'reset_password', 'enable_rescue', 'disable_rescue', 'attach_iso', 'detach_iso', 'change_protection'] as const
export type ManagementAction = typeof managementActions[number]
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
