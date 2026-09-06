import { apiDelete, apiGet, apiPatch, apiPost, apiPut, isApiConfigured } from './apiClient'
import type {
  AppNotification,
  ChargeRequest,
  CreateServerPayload,
  CreateTicketPayload,
  CreateWalletPayload,
  DashboardSummary,
  Domain,
  DomainAvailability,
  DomainOrder,
  Invoice,
  IpAddress,
  Paginated,
  Profile,
  Server,
  Session,
  Ticket,
  TicketSummary,
  TrafficPackage,
  Transaction,
  Wallet,
  WalletSummary,
} from './types'

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.items)) return record.items as T[]
    if (Array.isArray(record.data)) return record.data as T[]
    if (Array.isArray(record.results)) return record.results as T[]
  }
  return []
}

function unwrapOne<T>(payload: unknown, fallback: T): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data ?? fallback
  }
  return (payload as T) ?? fallback
}

const EMPTY_SUMMARY: DashboardSummary = {
  activeServers: 0,
  ips: 0,
  domains: 0,
  trafficPackages: 0,
  openTickets: 0,
  unpaidInvoices: 0,
  walletBalance: 0,
}

const noApi = () => !isApiConfigured()

// --- Dashboard / overview -------------------------------------------------

export async function getDashboardSummary(): Promise<DashboardSummary> {
  if (noApi()) return EMPTY_SUMMARY
  const payload = await apiGet<DashboardSummary | { data: DashboardSummary }>('/dashboard/summary')
  return unwrapOne(payload, EMPTY_SUMMARY)
}

export async function getRecentServers(): Promise<Server[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Server> | Server[]>('/servers?limit=5')
  return unwrapList<Server>(payload).slice(0, 5)
}

export async function getRecentTickets(): Promise<Ticket[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Ticket> | Ticket[]>('/tickets?limit=5')
  return unwrapList<Ticket>(payload).slice(0, 5)
}

export async function getWalletSummary(): Promise<WalletSummary> {
  if (noApi()) {
    return { totalBalance: 0, wallets: 0, defaultWallet: 'پیش‌فرض', connectedProducts: 0 }
  }
  const payload = await apiGet<WalletSummary | { data: WalletSummary }>('/wallets/summary')
  return unwrapOne(payload, { totalBalance: 0, wallets: 0, defaultWallet: 'پیش‌فرض', connectedProducts: 0 })
}

export async function getNotifications(): Promise<AppNotification[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<AppNotification> | AppNotification[]>('/notifications')
  return unwrapList<AppNotification>(payload)
}

// --- Servers / IPs / traffic / domains ------------------------------------

export async function listServers(): Promise<Server[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Server> | Server[]>('/servers')
  return unwrapList<Server>(payload)
}

export async function createServer(payload: CreateServerPayload): Promise<Server> {
  const created = await apiPost<Server | { data: Server }>('/servers', payload)
  return unwrapOne(created, { id: `srv-${Date.now()}`, name: payload.name, status: 'building', datacenter: payload.region, cpu: '', ram: '', disk: '' })
}

export async function listIps(): Promise<IpAddress[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<IpAddress> | IpAddress[]>('/ips')
  return unwrapList<IpAddress>(payload)
}

export async function buyIp(): Promise<IpAddress> {
  return unwrapOne(await apiPost<IpAddress | { data: IpAddress }>('/ips', {}), {
    id: `ip-${Date.now()}`,
    address: '',
    version: 'IPv4',
    status: 'reserved',
    datacenter: '',
  })
}

export async function listTrafficPackages(): Promise<TrafficPackage[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<TrafficPackage> | TrafficPackage[]>('/traffic-packages')
  return unwrapList<TrafficPackage>(payload)
}

export async function buyTrafficPackage(): Promise<TrafficPackage> {
  return unwrapOne(await apiPost<TrafficPackage | { data: TrafficPackage }>('/traffic-packages', {}), {
    id: `pkg-${Date.now()}`,
    name: '',
    connectedServers: 0,
    downloadGb: 0,
    uploadGb: 0,
    status: 'pending',
  })
}

export async function listDomains(): Promise<Domain[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Domain> | Domain[]>('/domains')
  return unwrapList<Domain>(payload)
}

export async function listDomainOrders(): Promise<DomainOrder[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<DomainOrder> | DomainOrder[]>('/domains/orders')
  return unwrapList<DomainOrder>(payload)
}

export async function checkDomainAvailability(domain: string): Promise<DomainAvailability> {
  if (noApi()) return { domain, available: true, pricePerYear: 990000 }
  const payload = await apiGet<DomainAvailability | { data: DomainAvailability }>(
    `/domains/availability?domain=${encodeURIComponent(domain)}`,
  )
  return unwrapOne(payload, { domain, available: true, pricePerYear: 990000 })
}

export async function registerDomain(payload: { domain: string; periodYears: number; walletId?: string }): Promise<DomainOrder> {
  return unwrapOne(await apiPost<DomainOrder | { data: DomainOrder }>('/domains', payload), {
    id: `order-${Date.now()}`,
    domain: payload.domain,
    status: 'pending',
  })
}

export async function transferDomain(domain: string): Promise<void> {
  await apiPost('/domains/transfer', { domain })
}

// --- Finance ---------------------------------------------------------------

export async function listWallets(): Promise<Wallet[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Wallet> | Wallet[]>('/wallets')
  return unwrapList<Wallet>(payload)
}

export async function createWallet(payload: CreateWalletPayload): Promise<Wallet> {
  return unwrapOne(await apiPost<Wallet | { data: Wallet }>('/wallets', payload), {
    id: `wallet-${Date.now()}`,
    name: payload.name,
    balance: 0,
    isDefault: payload.isDefault,
    description: payload.description,
  })
}

export async function listTransactions(): Promise<Transaction[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Transaction> | Transaction[]>('/wallets/transactions')
  return unwrapList<Transaction>(payload)
}

export async function listInvoices(): Promise<Invoice[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Invoice> | Invoice[]>('/invoices')
  return unwrapList<Invoice>(payload)
}

export async function listChargeRequests(): Promise<ChargeRequest[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<ChargeRequest> | ChargeRequest[]>('/charge-requests')
  return unwrapList<ChargeRequest>(payload)
}

// --- Tickets ----------------------------------------------------------------

export async function listTickets(): Promise<Ticket[]> {
  if (noApi()) return []
  const payload = await apiGet<Paginated<Ticket> | Ticket[]>('/tickets')
  return unwrapList<Ticket>(payload)
}

export async function getTicketSummary(): Promise<TicketSummary> {
  if (noApi()) return { total: 0, open: 0, reviewing: 0, answered: 0, unread: 0 }
  const payload = await apiGet<TicketSummary | { data: TicketSummary }>('/tickets/summary')
  return unwrapOne(payload, { total: 0, open: 0, reviewing: 0, answered: 0, unread: 0 })
}

export async function createTicket(payload: CreateTicketPayload): Promise<Ticket> {
  return unwrapOne(await apiPost<Ticket | { data: Ticket }>('/tickets', payload), {
    id: `ticket-${Date.now()}`,
    title: payload.title,
    department: payload.department,
    status: 'pending',
  })
}

// --- Account -----------------------------------------------------------------

export async function getProfile(): Promise<Profile | null> {
  if (noApi()) return null
  const payload = await apiGet<Profile | { data: Profile }>('/profile')
  return unwrapOne<Profile | null>(payload, null)
}

export async function updateProfile(payload: Profile): Promise<Profile> {
  return unwrapOne(await apiPut<Profile | { data: Profile }>('/profile', payload), payload)
}

export async function verifyNationalCode(payload: { nationalCode: string; mobile: string }): Promise<void> {
  await apiPost('/profile/verify-national-code', payload)
}

export async function listSessions(): Promise<Session[]> {
  if (noApi()) {
    return [{ id: 'current', device: 'Chrome روی Windows', location: 'Asia/Tehran', lastActivity: 'همین حالا', current: true }]
  }
  const payload = await apiGet<Paginated<Session> | Session[]>('/sessions')
  const items = unwrapList<Session>(payload)
  return items.length
    ? items
    : [{ id: 'current', device: 'Chrome روی Windows', location: 'Asia/Tehran', lastActivity: 'همین حالا', current: true }]
}

export async function revokeOtherSessions(): Promise<void> {
  await apiDelete('/sessions/others')
}

export async function updateTimezone(timezone: string): Promise<void> {
  if (noApi()) return
  await apiPatch('/settings/timezone', { timezone })
}
