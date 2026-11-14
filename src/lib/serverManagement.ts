import { apiGet, apiPost } from './apiClient'
import type { Server, ServerLifecycle } from './types'
export type { ManagementAction } from '../../backend/src/modules/providers/customer.interface'
import type { ManagementAction, ServerAccessBlock, ServerAccessEligibility, ServerMetrics } from '../../backend/src/modules/providers/customer.interface'
export type { ServerAccessBlock } from '../../backend/src/modules/providers/customer.interface'
export type { ServerMetrics }
export interface ServerOperation {
  id: string; action: ManagementAction; status: 'queued' | 'dispatching' | 'provider_accepted' | 'confirmed' | 'outcome_unknown' | 'failed'
  actionId: number | null; createdAt: string; updatedAt: string; completedAt: string | null; message: string | null
}
export interface ServerDetail extends Server {
  lifecycle: ServerLifecycle; providerAvailable: boolean; providerIdentity: string; providerState: string | null
  facts: null | { hostname: string | null; vcpu: number | null; memoryMb: number | null; diskGb: number | null; ipv4: string | null; ipv6: string | null;
    createdAt: string | null; location: string | null; serverType: string | null; image: string | null; imageId: string | null;
    outgoingTrafficBytes: number | null; includedTrafficBytes: number | null; trafficPeriod: string | null;
    protection: { delete: boolean; rebuild: boolean } | null; rescueEnabled: boolean | null; isoId: string | null; backupWindow: string | null;
    volumes: number[]; privateNetworks: Array<{ id: number; ip: string }>; firewalls: Array<{ id: number; status: string }>; floatingIps: number[] }
  billing: { subscriptionId: string | null; state: string | null; period: string | null; customerPriceRial: number | null; nextInvoiceAt: string | null;
    currentPeriodEnd: string | null; autoRenew: boolean; futureDebits: 'stopped' | 'held_pending_confirmation' | 'normal'; refundPolicy: string;
    providerQuotedRate: { currency: string; amountCents: number; period: string; observedAt: string } | null }
  capabilities: { power: boolean; resize: boolean; rebuild: boolean; resetPassword: boolean; console: boolean; rescue: boolean; protection: boolean;
    iso: boolean; snapshots: boolean; backups: boolean; volumes: boolean; networkMutations: boolean; unavailableReason: string }
  accessEligibility?: ServerAccessEligibility
  resizeBlock?: ServerAccessBlock | null
  operations: ServerOperation[]; credentials: Array<{ operationId: string | null; claimedAt: string | null; acknowledgedAt: string | null }>
}
export interface ResizeOption { type: string; architecture: string; storageType: string; vcpu: number; memoryMb: number; diskGb: number; available: boolean; offerId: string }
export interface ResizePreview { quoteId: string; serverType: string; upgradeDisk: boolean; priceRial: number; currentPriceRial: number; period: string; effectiveAt: string; expiresAt: string; immediateChargeRial: number }
export const getServerDetail = async (id: string, refresh = false) =>
  (await apiGet<{ data: ServerDetail }>(`/servers/${encodeURIComponent(id)}/management${refresh ? '?refresh=1' : ''}`)).data
export const recheckServerOperation = async (serverId: string, operationId: string) =>
  (await apiPost<{ data: { operation: ServerOperation; checkFailed: boolean } }>(
    `/servers/${encodeURIComponent(serverId)}/management/operations/${encodeURIComponent(operationId)}/recheck`, {}, { timeoutMs: 65_000 })).data
export const getServerMetrics = async (id: string, window: string) => (await apiGet<{ data: ServerMetrics }>(`/servers/${encodeURIComponent(id)}/metrics?window=${encodeURIComponent(window)}`)).data
export const getResizeOptions = async (id: string) => (await apiGet<{ data: ResizeOption[] }>(`/servers/${encodeURIComponent(id)}/resize-options`)).data
export const getServerImages = async (id: string) => (await apiGet<{ data: Array<{ id: string; name: string }> }>(`/servers/${encodeURIComponent(id)}/images`)).data
export const previewResize = async (id: string, offerId: string, upgradeDisk: boolean) => (await apiPost<{ data: ResizePreview }>(`/servers/${encodeURIComponent(id)}/resize-preview`, { offerId, upgradeDisk })).data
export const submitServerAction = async (id: string, hostname: string, action: ManagementAction, input: Record<string, unknown>, key: string) =>
  (await apiPost<{ data: ServerOperation }>(`/servers/${encodeURIComponent(id)}/management/actions`, { ...input, action, hostname, confirm: true }, { headers: { 'idempotency-key': key } })).data
export const claimServerPassword = async (id: string, operationId: string) => (await apiPost<{ data: { password: string; expiresAt: string } }>(`/servers/${encodeURIComponent(id)}/credentials/claim`, { operationId })).data
export const acknowledgeServerPassword = (id: string, operationId: string) => apiPost(`/servers/${encodeURIComponent(id)}/credentials/ack`, { operationId })
export const requestServerConsole = async (id: string) => (await apiPost<{ data: { grantId: string; password: string; expiresAt: string; maxSessionSeconds: number } }>(`/servers/${encodeURIComponent(id)}/console`, {})).data
export const actionLabels: Record<ManagementAction, string> = { power_on: 'روشن کردن', shutdown: 'خاموشی نرم (ACPI)', power_off: 'خاموشی اجباری', reboot: 'راه‌اندازی مجدد نرم', reset: 'ریست سخت‌افزاری', delete: 'حذف دائمی سرور', resize: 'تغییر پلن', rebuild: 'نصب مجدد سیستم‌عامل', reset_password: 'بازنشانی رمز عبور', enable_rescue: 'فعال‌سازی Rescue', disable_rescue: 'غیرفعال‌سازی Rescue', attach_iso: 'اتصال ISO', detach_iso: 'قطع ISO', change_protection: 'تغییر حفاظت سرور' }
