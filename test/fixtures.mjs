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

// A separate site-authority scenario for current-browser checkout/admin QA.
export function checkoutFixture(path) {
  const base = fixture(path)
  if (path === '/auth/me') return { data: { ...base.data, role: 'admin' } }
  if (path === '/integration/status') return { data: { enabled: false, linked: false } }
  if (path === '/wallets') return { data: [{ id: 'preview-wallet', name: 'کیف پول آزمایشی', balance: 0, isDefault: true }] }
  if (path === '/wallets/summary') return { data: { totalBalance: 0, wallets: 1, defaultWallet: 'کیف پول آزمایشی', connectedProducts: 0 } }
  if (path === '/wallets/recharge/options') return { data: { enabled: true, gateways: ['tabapay'], wallets: [{ id: 'preview-wallet', name: 'کیف پول آزمایشی', balance: 0, isDefault: true }] } }
  if (path === '/tickets/servers') return { data: [{ id: serverId, name: 'سرور آزمایشی آلمان', ip: '192.0.2.10', status: 'active' }, { id: offerId, name: 'سرور آزمایشی فنلاند', ip: '192.0.2.20', status: 'active' }] }
  if (path === '/admin/console/providers') return { data: [{ id: 'hetzner', name: 'Hetzner', enabled: true, configured: true }, { id: 'leaseweb', name: 'Leaseweb', enabled: false, configured: true }] }
  if (path === '/catalog/storefront') {
    const locations = [{ code: 'nbg1', country: 'DE', city: 'Nuremberg' }, { code: 'fsn1', country: 'DE', city: 'Falkenstein' }, { code: 'hel1', country: 'FI', city: 'Helsinki' }, { code: 'ash', country: 'US', city: 'Ashburn' }, { code: 'sin', country: 'SG', city: 'Singapore' }]
    return { data: {
      datacenters: [{ id: 'hetzner', name: 'Hetzner', logo: '/providers/hetzner.svg', locations, billingPeriods: ['hourly', 'daily', 'monthly'] }],
      offers: locations.flatMap(location => [
        { name: 'CX43', price: 88000, vcpu: 8, memoryMb: 16384, diskGb: 160 },
        { name: 'CX23', price: 36000, vcpu: 2, memoryMb: 4096, diskGb: 40 },
        { name: 'CX33', price: 56000, vcpu: 4, memoryMb: 8192, diskGb: 80 },
      ].map(plan => ({ id: location.code + '-' + plan.name, provider: 'hetzner', location: location.code, category: 'cloud', ...plan, trafficGb: 20000,
        operatingSystems: [{ id: 'ubuntu-24.04', label: 'Ubuntu 24.04' }, { id: 'debian-12', label: 'Debian 12' }],
        prices: [{ period: 'hourly', totalRial: plan.price, billingCycle: 'hourly' }, { period: 'daily', totalRial: plan.price * 24, billingCycle: 'hourly' }, { period: 'monthly', totalRial: plan.price * 720, billingCycle: 'monthly' }],
      }))),
    } }
  }
  return base
}
