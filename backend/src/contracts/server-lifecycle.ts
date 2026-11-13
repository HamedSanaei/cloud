/** Transport contract shared with the browser. No provider credentials or DB imports. */
export const provisioningStates = ['queued', 'provisioning', 'ready', 'failed', 'requires_review', 'outcome_unknown', 'cancelled'] as const
export type ProvisioningState = typeof provisioningStates[number]
export type ServerLifecycle = ProvisioningState | 'deletion_requested' | 'deleting' | 'terminated' | 'delete_failed'
export interface ServerTracking {
  source: 'site' | 'platform'
  reference: string
  orderId: string | null
  serverId: string | null
  operationId: string | null
  state: ProvisioningState
  createdAt: string
  updatedAt: string
}
export function provisionState(orderStatus: string, operationStatus?: string): ProvisioningState {
  if (operationStatus === 'unknown' || operationStatus === 'needs_reconciliation') return 'outcome_unknown'
  if (orderStatus === 'requires_review') return 'requires_review'
  if (orderStatus === 'failed' || orderStatus === 'refunded') return 'failed'
  if (orderStatus === 'cancelled') return 'cancelled'
  if (orderStatus === 'active') return 'ready'
  return orderStatus === 'provisioning' ? 'provisioning' : 'queued'
}
