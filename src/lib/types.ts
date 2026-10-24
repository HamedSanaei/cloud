export type ServerStatus = 'active' | 'inactive' | 'building'
export type IpStatus = 'active' | 'inactive' | 'reserved'
export type IpVersion = 'IPv4' | 'IPv6'

export interface DashboardSummary {
  activeServers: number
  ips: number
  domains: number
  trafficPackages: number
  openTickets: number
  unpaidInvoices: number
  walletBalance: number
}

export interface Server {
  id: string
  /** Canonical management identity; never inferred from a legacy database row. */
  platformServerId?: string
  name: string
  status: ServerStatus
  datacenter: string
  cpu: string
  ram: string
  disk: string
  ip?: string
  createdAt?: string
  power: {
    canPowerOn: boolean
    canPowerOff: boolean
    canReboot: boolean
    billingBlocked: boolean
    requiredBalanceToman: number | null
    pendingAction: 'power_on' | 'power_off' | 'reboot' | null
  }
}

export interface CreateServerPayload {
  name: string
  offerId: string
  os: string
  walletId?: string
  billingPeriod: BillingPeriod
  pricing?: { expectedMinor: number; expectedCurrency: string }
  idempotencyKey?: string
}

export type BillingPeriod = 'hourly' | 'daily' | 'monthly'

export interface StorefrontDatacenter {
  id: string
  name: string
  logo: string
  locations: Array<{ code: string; country: string | null; city: string | null }>
  billingPeriods: BillingPeriod[]
}

export interface StorefrontOffer {
  id: string
  provider: string
  location: string
  name: string
  category: string
  vcpu: number
  memoryMb: number
  diskGb: number
  trafficGb: number | null
  operatingSystems: Array<{ id: string; label?: string; family?: string }>
  prices: Array<{ period: BillingPeriod; totalRial: number; billingCycle: string; contractTerm?: string | number }>
  canonicalPricing?: { expectedMinor: number; expectedCurrency: string }
}

export interface StorefrontCatalog {
  datacenters: StorefrontDatacenter[]
  offers: StorefrontOffer[]
  source?: 'platform'
}

export interface IpAddress {
  id: string
  address: string
  version: IpVersion
  status: IpStatus
  server?: string
  datacenter: string
}

export interface TrafficPackage {
  id: string
  name: string
  connectedServers: number
  downloadGb: number
  uploadGb: number
  status: string
}

export interface Domain {
  id: string
  name: string
  status: string
  expiresAt?: string
}

export interface DomainOrder {
  id: string
  domain: string
  status: string
  createdAt?: string
}

export interface DomainAvailability {
  domain: string
  available: boolean
  pricePerYear: number
}

export interface Wallet {
  id: string
  name: string
  balance: number
  isDefault: boolean
  description?: string
  connectedProducts?: number
}

export interface WalletSummary {
  totalBalance: number
  wallets: number
  defaultWallet: string
  connectedProducts: number
}

export interface Transaction {
  id: string
  description: string
  wallet: string
  amount: number
  date: string
  status: string
  formattedAmount?: string
}

export interface Invoice {
  id: string
  number: string
  description: string
  amount: number
  status: string
  date: string
}

export interface ChargeRequest {
  id: string
  number: string
  invoiceNumber?: string
  amount: number
  status: string
  date: string
  currency?: string
  formattedAmount?: string
}

export type TicketStatus = 'pending' | 'review' | 'answered' | 'closed'
export type TicketDepartment = 'technical' | 'finance' | 'sales'

export interface Ticket {
  id: string
  title: string
  department: string
  status: string
  updatedAt?: string
  unread?: boolean
}

export interface TicketSummary {
  total: number
  open: number
  reviewing: number
  answered: number
  unread: number
}

export interface CreateTicketPayload {
  title: string
  department: TicketDepartment | string
  description: string
}

export interface CreateWalletPayload {
  name: string
  description?: string
  isDefault: boolean
}

export interface Profile {
  firstName: string
  lastName: string
  mobile: string
  nationalCode: string
  email: string
  legalEnabled: boolean
  companyName?: string
  nationalId?: string
  registrationNumber?: string
  economicCode?: string
}

export interface Session {
  id: string
  device: string
  location: string
  lastActivity: string
  current: boolean
}

export interface AppNotification {
  id: string
  title: string
  body: string | null
  type: string
  read: boolean
  createdAt?: string
}

export interface Paginated<T> {
  items: T[]
  total: number
}
