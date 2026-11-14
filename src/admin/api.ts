import { apiGet, apiPatch, apiPost } from '../lib/apiClient'
import type { ServerOperation } from '../lib/serverManagement'
import type { ServerActionEvidence } from '../../backend/src/modules/providers/customer.interface'
import type { Ticket } from '../lib/types'

export interface AdminUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  mobile: string | null
  role: 'admin' | 'user'
  status: 'active' | 'pending' | 'disabled'
  emailVerifiedAt: string | null
  mobileVerifiedAt: string | null
  createdAt: string
  balanceRial?: number
  balanceToman?: number
  serverCount?: number
}
export interface AdminOrder {
  id: string
  orderNumber: string
  userId: string
  userName?: string
  userEmail?: string
  status: string
  totalRial: number
  totalToman: number
  hostname: string
  provider: string
  providerProductId: string
  providerLocation: string
  billingInterval: string
  operatingSystem: string
  paidAt: string | null
  createdAt: string
  error: string | null
}
export interface AdminServer {
  id: string
  userId: string
  orderId: string
  name: string
  status: string
  provider: string
  providerLocation: string
  providerServerId: string | null
  ipv4: string | null
  ipv6: string | null
  vcpu: number
  memoryMb: number
  diskGb: number
  operatingSystem: string
  trafficLimitGb: number | null
  trafficUsedGb: number
  createdAt: string
  activatedAt: string | null
  lastSyncedAt: string | null
  ownerName?: string
  ownerEmail?: string
}
export interface HetznerFleetServer {
  providerServerId: string
  accountId: string
  name: string
  status: string
  ipv4: string | null
  ipv6: string | null
  vcpu: number | null
  memoryMb: number | null
  diskGb: number | null
  location: string | null
  serverType: string | null
  operatingSystem: string | null
  createdAt: string | null
  lastSeenAt: string
  source: 'website' | 'hetzner'
  websiteServerId: string | null
  websiteUserId: string | null
}
export interface HetznerFleet { items: HetznerFleetServer[]; accounts: number; syncedAt: string }

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  limit: number
  pages: number
}
export interface AdminOverview {
  source: 'website'
  users: number
  orders: number
  servers: number
  activeServers: number
  ordersNeedingAttention: number
  paidOrderTotalRial: number
  paidOrderTotalToman: number
  recentOrders: AdminOrder[]
}
export interface AdminUserDetail {
  user: AdminUser
  balanceRial: number
  balanceToman: number
  wallets: Array<{ id: string; name: string; currency: string; isDefault: boolean; balanceRial: number; balanceToman: number }>
  transactions: Array<{ id: string; walletId: string; type: string; description: string | null; amountRial: number; amountToman: number; createdAt: string }>
  servers: AdminServer[]
  orders: AdminOrder[]
}
export interface AdminOrderDetail {
  order: AdminOrder
  user: AdminUser | null
  items: Array<{ id: string; description: string; quantity: number; totalRial: number; totalToman: number }>
  events: Array<{ fromStatus: string | null; toStatus: string; reason: string | null; createdAt: string }>
  invoice: { id: string; number: string; status: string; totalRial: number } | null
}
export interface AdminServerDetail {
  server: AdminServer
  owner: AdminUser | null
  legacyPowerOperation?: ServerOperation | null
}
export interface LegacyPowerEvidence { state: string; candidates: ServerActionEvidence[] }
const legacyPowerPath = (serverId: string, operationId: string) =>
  `/admin/console/servers/${encodeURIComponent(serverId)}/legacy-power/${encodeURIComponent(operationId)}`
export interface ListFilters { page: number; search: string; status: string; limit?: number }
const prefix = '/admin/console'
const fetchData = async <T>(path: string): Promise<T> =>
  (await apiGet<{ data: T }>(prefix + path, { timeoutMs: 25000 })).data
const listQuery = ({ page, search, status, limit = 20 }: ListFilters) =>
  '?' + new URLSearchParams({ page: String(page), limit: String(limit), search: search.trim(), status }).toString()
export const adminApi = {
  tickets: (filter: ListFilters) => fetchData<Paged<Ticket & { ownerEmail: string }>>('/tickets' + listQuery(filter)),
  providers: () => fetchData<Array<{ id: string; name: string; enabled: boolean; configured: boolean }>>('/providers'),
  setProviderSales: (id: string, enabled: boolean) => apiPatch(prefix + '/providers/' + encodeURIComponent(id), { enabled }),
  overview: () => fetchData<AdminOverview>('/overview'),
  users: (filter: ListFilters) => fetchData<Paged<AdminUser>>('/users' + listQuery(filter)),
  user: (id: string) => fetchData<AdminUserDetail>('/users/' + encodeURIComponent(id)),
  userServers: (id: string, filter: ListFilters) => fetchData<Paged<AdminServer>>('/users/' + encodeURIComponent(id) + '/servers' + listQuery(filter)),
  orders: (filter: ListFilters) => fetchData<Paged<AdminOrder>>('/orders' + listQuery(filter)),
  order: (id: string) => fetchData<AdminOrderDetail>('/orders/' + encodeURIComponent(id)),
  servers: (filter: ListFilters) => fetchData<Paged<AdminServer>>('/servers' + listQuery(filter)),
  hetznerInventory: async () => (await apiGet<{ data: HetznerFleet }>(prefix + '/hetzner/inventory', { timeoutMs: 120000 })).data,
  server: (id: string) => fetchData<AdminServerDetail>('/servers/' + encodeURIComponent(id)),
  legacyPowerEvidence: async (serverId: string, operationId: string) => (await apiGet<{ data: LegacyPowerEvidence }>(legacyPowerPath(serverId, operationId), { timeoutMs: 65_000 })).data,
  resolveLegacyPower: (serverId: string, operationId: string, actionId: number, note: string) =>
    apiPost(legacyPowerPath(serverId, operationId), { actionId, note }, { timeoutMs: 65_000 }),
}
export const userName = (u?: Pick<AdminUser, 'firstName' | 'lastName' | 'email'> | null) =>
  u ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email : '—'
