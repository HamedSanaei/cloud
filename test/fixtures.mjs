// Synthetic fixtures for automated tests and the explicitly isolated design preview ONLY.
// Never imported by src/ or deployed as an application API.
export const offerId = 'f07b9500-414e-4000-8000-000000000001'
export const serverId = 'f07b9500-414e-4000-8000-000000000002'
export function fixture(path) {
  const data = {
    '/auth/me': { id: 'preview-user', email: 'preview@example.test', role: 'user', status: 'active', firstName: 'پیش‌نمایش' },
    '/integration/status': { enabled: true, linked: true },
    '/notifications': [],
    '/dashboard/summary': { activeServers: 0, ips: 0, domains: 0, trafficPackages: 0, openTickets: 0, unpaidInvoices: 0, walletBalance: 250000 },
    '/servers': [], '/tickets': [], '/ips': [], '/invoices': [], '/charge-requests': [], '/traffic-packages': [], '/domains': [],
    '/wallets/summary': { totalBalance: 250000, wallets: 1, defaultWallet: 'مشترک تلگرام و سایت', connectedProducts: 0 },
    '/wallets': [{ id: 'platform', name: 'مشترک تلگرام و سایت', balance: 250000, isDefault: true }],
    '/wallets/transactions': [],
    '/catalog/storefront': { source: 'platform', datacenters: [{ id: 'hetzner', name: 'Hetzner', logo: '/providers/hetzner.svg', locations: [{ code: 'fsn1', city: null, country: null }], billingPeriods: ['hourly'] }], offers: [{ id: offerId, provider: 'hetzner', location: 'fsn1', name: 'CX Preview', category: 'cloud', vcpu: 2, memoryMb: 4096, diskGb: 40, trafficGb: null, operatingSystems: [], prices: [{ period: 'hourly', totalRial: 12000, billingCycle: 'hourly' }], canonicalPricing: { expectedMinor: 4, expectedCurrency: 'USD' } }] },
    [`/platform/offers/${offerId}/images`]: [{ id: 'ubuntu-24.04', name: 'Ubuntu 24.04' }],
    '/platform/account': { superadmin: false, testPortManagement: false },
    '/platform/wallet': { balance: { currency: 'IRT', balance_minor: 250000 }, history: { items: [] } },
    '/platform/recharge/gateways': ['preview'],
    '/platform/orders': { serverId },
    '/integration/disconnect': { linked: false }, '/integration/connect': { linked: true },
  }
  return path in data ? { data: data[path] } : { data: [] }
}
