/**
 * Mock-mode catalog fixtures.
 *
 * These are DEMO fixtures for LEASEWEB_MODE=mock so the platform can be
 * developed, tested and demonstrated end-to-end without spending money.
 *
 * IMPORTANT: this is NOT the source of truth for real Leaseweb pricing or for
 * billing enum values. In live mode the catalog is built exclusively from the
 * Leaseweb Ordering API responses (`/ordering/v1/products/vps`), and the
 * allowed billingCycle/contractTerm values are whatever that API returns for
 * the configured account. Mock fixtures model the same SHAPE (periodMonths,
 * billingCycle, contractTerm) so normalization code is identical in both modes.
 *
 * Shapes mirror the public Leaseweb VPS offering (local NVMe, 10 Gbps uplink,
 * ~30 TB outgoing traffic on VPS packages, free incoming traffic, standard
 * DDoS protection, IPv4 + IPv6, snapshot support).
 */

import type { ProviderOffer } from '../provider.interface.js'

export interface MockLocationDef {
  code: string
  country: string
  city: string
}

export const MOCK_LOCATIONS: MockLocationDef[] = [
  { code: 'AMS-01', country: 'Netherlands', city: 'Amsterdam' },
  { code: 'FRA-01', country: 'Germany', city: 'Frankfurt' },
  { code: 'ASH-01', country: 'United States', city: 'Ashburn' },
  { code: 'LAX-01', country: 'United States', city: 'Los Angeles' },
  { code: 'SIN-01', country: 'Singapore', city: 'Singapore' },
]

interface MockProductDef {
  id: string
  name: string
  vcpu: number
  memoryMb: number
  diskGb: number
  /** Monthly list price in EUR cents (fixture only). */
  monthlyEuros: number
  trafficGb?: number
  ipv4Count?: number
  ipv6?: boolean
}

// Realistic VPS tiers. Prices are fixtures — replaced by live API data in
// live mode.
export const MOCK_PRODUCTS: MockProductDef[] = [
  { id: 'VPS02_1', name: 'VPS 2 vCPU / 1 GB', vcpu: 2, memoryMb: 1024, diskGb: 25, monthlyEuros: 5.5, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS02_2', name: 'VPS 2 vCPU / 2 GB', vcpu: 2, memoryMb: 2048, diskGb: 50, monthlyEuros: 8.25, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS02_4', name: 'VPS 2 vCPU / 4 GB', vcpu: 2, memoryMb: 4096, diskGb: 100, monthlyEuros: 14.5, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS04_4', name: 'VPS 4 vCPU / 4 GB', vcpu: 4, memoryMb: 4096, diskGb: 100, monthlyEuros: 22, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS04_8', name: 'VPS 4 vCPU / 8 GB', vcpu: 4, memoryMb: 8192, diskGb: 200, monthlyEuros: 34, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS08_8', name: 'VPS 8 vCPU / 8 GB', vcpu: 8, memoryMb: 8192, diskGb: 200, monthlyEuros: 52, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS08_16', name: 'VPS 8 vCPU / 16 GB', vcpu: 8, memoryMb: 16384, diskGb: 400, monthlyEuros: 79, trafficGb: 30_000, ipv4Count: 1, ipv6: true },
  { id: 'VPS16_32', name: 'VPS 16 vCPU / 32 GB', vcpu: 16, memoryMb: 32768, diskGb: 600, monthlyEuros: 139, trafficGb: 30_000, ipv4Count: 2, ipv6: true },
]

export const MOCK_OPERATING_SYSTEMS = [
  { id: 'ubuntu-24.04', label: 'Ubuntu 24.04 LTS', family: 'ubuntu' },
  { id: 'ubuntu-22.04', label: 'Ubuntu 22.04 LTS', family: 'ubuntu' },
  { id: 'debian-12', label: 'Debian 12', family: 'debian' },
  { id: 'centos-stream-9', label: 'CentOS Stream 9', family: 'centos' },
  { id: 'rocky-9', label: 'Rocky Linux 9', family: 'rocky' },
]

export const MOCK_SERVICE_LEVELS = [{ id: 'STANDARD', label: 'Standard SLA' }]

/**
 * Billing options for one product. Monthly is the option the platform exposes
 * first. Values are fixtures for mock mode only — see the note at the top.
 */
export function mockBillingOptionsFor(product: MockProductDef, _locationCode: string) {
  const monthlyCents = Math.round(product.monthlyEuros * 100)
  return [
    {
      billingCycle: 'monthly',
      label: 'Monthly',
      contractTerm: 0,
      periodMonths: 1,
      amountCents: monthlyCents,
      amount: (product.monthlyEuros * 1.0).toFixed(2),
      monthly: true,
      // 12-month commitment at a small discount — fixture only.
    },
    {
      billingCycle: 'monthly',
      label: 'Monthly (12-month commitment)',
      contractTerm: 12,
      periodMonths: 1,
      amountCents: Math.round(monthlyCents * 0.92),
      amount: (product.monthlyEuros * 0.92).toFixed(2),
      monthly: true,
    },
  ]
}

export function buildMockOffers(): ProviderOffer[] {
  const offers: ProviderOffer[] = []
  for (const location of MOCK_LOCATIONS) {
    for (const product of MOCK_PRODUCTS) {
      offers.push({
        provider: 'leaseweb',
        providerProductId: product.id,
        location: location.code,
        name: product.name,
        vcpu: product.vcpu,
        memoryMb: product.memoryMb,
        diskGb: product.diskGb,
        trafficGb: product.trafficGb ?? null,
        ipv4Count: product.ipv4Count ?? 1,
        ipv6Available: product.ipv6 ?? true,
        providerCurrency: 'EUR',
        providerPriceCents: Math.round(product.monthlyEuros * 100),
        billingOptions: mockBillingOptionsFor(product, location.code),
        operatingSystems: MOCK_OPERATING_SYSTEMS,
        serviceLevels: MOCK_SERVICE_LEVELS,
      })
    }
  }
  return offers
}

export const MOCK_RAW_SYNC = {
  products: MOCK_PRODUCTS.map((p) => ({ id: p.id, name: p.name, vcpu: p.vcpu, memoryMb: p.memoryMb, diskGb: p.diskGb })),
  locations: MOCK_LOCATIONS,
  note: 'mock fixtures — live mode replaces this with the Leaseweb Ordering API response',
}