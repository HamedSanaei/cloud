/**
 * API DTO mappings.
 *
 * Money: the DB stores integer rials; the API exposes integer TOMAN values
 * (the unit the UI displays) plus exact rial fields where useful. Never send
 * floats. Provider amounts are exposed in cents + currency.
 *
 * Status tokens follow the tokens the current frontend consumes
 * (active|building|inactive, pending|paid|cancelled|refunded, ...).
 */
import { rialToToman } from './money.js'

export function serverToDto(server: {
  id: string
  name?: string | null
  hostname: string
  status: string
  providerLocation: string
  vcpu: number
  memoryMb: number
  diskGb: number
  ipv4?: string | null
  operatingSystem: string
  createdAt: Date
}) {
  return {
    id: server.id,
    name: server.name ?? server.hostname,
    status: mapServerStatus(server.status),
    datacenter: server.providerLocation,
    cpu: `${server.vcpu} vCPU`,
    ram: `${server.memoryMb} MB`,
    disk: `${server.diskGb} GB`,
    ip: server.ipv4 ?? undefined,
    os: server.operatingSystem,
    createdAt: server.createdAt.toISOString(),
  }
}

export function mapServerStatus(status: string): 'active' | 'building' | 'inactive' {
  if (status === 'active') return 'active'
  if (status === 'provisioning') return 'building'
  return 'inactive'
}

export function walletToDto(wallet: { id: string; name: string; balanceRial: number; isDefault: boolean; description?: string | null }) {
  return {
    id: wallet.id,
    name: wallet.name,
    balance: rialToToman(wallet.balanceRial),
    balanceRial: wallet.balanceRial,
    isDefault: wallet.isDefault,
    description: wallet.description ?? undefined,
  }
}

export function transactionToDto(tx: {
  id: string
  amountRial: number
  type: string
  description?: string | null
  createdAt: Date
  balanceAfterRial: number
}) {
  return {
    id: tx.id,
    description: tx.description ?? tx.type,
    amount: rialToToman(tx.amountRial),
    amountRial: tx.amountRial,
    date: tx.createdAt.toISOString(),
    status: tx.amountRial < 0 ? 'success' : 'success',
    type: tx.type,
  }
}

export function invoiceToDto(invoice: {
  id: string
  invoiceNumber: string
  description?: string | null
  totalRial: number
  status: string
  createdAt: Date
  dueAt: Date
}) {
  return {
    id: invoice.id,
    number: invoice.invoiceNumber,
    description: invoice.description ?? '',
    amount: rialToToman(invoice.totalRial),
    amountRial: invoice.totalRial,
    status: mapInvoiceStatus(invoice.status),
    date: invoice.createdAt.toISOString(),
    dueAt: invoice.dueAt.toISOString(),
  }
}

export function mapInvoiceStatus(status: string): 'pending' | 'paid' | 'cancelled' | 'refunded' {
  if (status === 'paid') return 'paid'
  if (status === 'void') return 'cancelled'
  if (status === 'refunded') return 'refunded'
  return 'pending'
}

export function ticketToDto(ticket: { id: string; title: string; department: string; status: string; updatedAt: Date | null; createdAt: Date }) {
  return {
    id: ticket.id,
    title: ticket.title,
    department: ticket.department,
    status: ticket.status,
    updatedAt: (ticket.updatedAt ?? ticket.createdAt).toISOString(),
    unread: false,
  }
}

export function orderToDto(order: {
  id: string
  orderNumber: string
  status: string
  totalRial: number
  providerProductId: string
  providerLocation: string
  hostname: string
  createdAt: Date
}) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    amount: rialToToman(order.totalRial),
    amountRial: order.totalRial,
    product: order.providerProductId,
    location: order.providerLocation,
    hostname: order.hostname,
    createdAt: order.createdAt.toISOString(),
  }
}

export function subscriptionToDto(sub: {
  id: string
  billingInterval: string
  priceRial: number
  status: string
  autoRenew: boolean
  currentPeriodEnd: Date
  nextInvoiceAt: Date
}) {
  return {
    id: sub.id,
    billingInterval: sub.billingInterval,
    price: rialToToman(sub.priceRial),
    priceRial: sub.priceRial,
    status: sub.status,
    autoRenew: sub.autoRenew,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    nextInvoiceAt: sub.nextInvoiceAt.toISOString(),
  }
}

export function offerToDto(offer: {
  id: string
  provider: string
  providerProductId: string
  name: string
  vcpu: number
  memoryMb: number
  diskGb: number
  trafficGb: number | null
  ipv4Count: number
  ipv6Available: boolean
  providerCurrency: string
  providerPriceCents: number | null
  billingOptions: unknown
  operatingSystems: unknown
  serviceLevels: unknown
  locationId: string | null
}, locationCode?: string) {
  return {
    id: offer.id,
    provider: offer.provider,
    providerProductId: offer.providerProductId,
    location: locationCode ?? offer.locationId,
    name: offer.name,
    vcpu: offer.vcpu,
    memoryMb: offer.memoryMb,
    diskGb: offer.diskGb,
    trafficGb: offer.trafficGb,
    ipv4Count: offer.ipv4Count,
    ipv6Available: offer.ipv6Available,
    providerCurrency: offer.providerCurrency,
    providerPriceCents: offer.providerPriceCents,
    billingOptions: offer.billingOptions ?? [],
    operatingSystems: offer.operatingSystems ?? [],
    serviceLevels: offer.serviceLevels ?? [],
  }
}