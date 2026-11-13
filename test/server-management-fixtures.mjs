// Explicitly synthetic test/loopback-preview data. Never imported by production src/.
import { fixture, serverId, offerId } from './fixtures.mjs'
export const pendingOrderId = 'f07b9500-414e-4000-8000-000000000004'
export const readyServer = { id: serverId, serverId, orderId: offerId, provider: 'hetzner', name: 'web-parserver-01', status: 'active', lifecycle: 'ready',
  datacenter: 'hel1', serverType: 'CX23', os: 'Ubuntu 24.04', ip: '192.0.2.19', cpu: '2 vCPU', ram: '4096 MB', disk: '40 GB',
  tracking: { source: 'site', reference: offerId, orderId: offerId, serverId, operationId: null, state: 'ready', createdAt: '2026-11-14T08:00:00Z', updatedAt: '2026-11-14T08:01:00Z' },
  power: { canPowerOn: false, canPowerOff: true, canReboot: true, billingBlocked: false, requiredBalanceToman: 3600, pendingAction: null } }
export const pendingServer = { ...readyServer, id: `order:${pendingOrderId}`, serverId: undefined, orderId: pendingOrderId, name: 'new-project-node', status: 'building', lifecycle: 'provisioning',
  ip: undefined, cpu: '', ram: '', disk: '', tracking: { ...readyServer.tracking, reference: pendingOrderId, orderId: pendingOrderId, serverId: null, state: 'provisioning' },
  power: { ...readyServer.power, canPowerOn: false, canPowerOff: false, canReboot: false } }
export const detailServer = { ...readyServer, providerAvailable: true, providerIdentity: 'preview-project:1001', providerState: 'active',
  facts: { hostname: readyServer.name, vcpu: 2, memoryMb: 4096, diskGb: 40, ipv4: '192.0.2.19', ipv6: '2001:db8::/64',
    createdAt: '2026-11-14T08:00:00Z', location: 'Helsinki', serverType: 'CX23', image: 'Ubuntu 24.04', imageId: '11', outgoingTrafficBytes: 15360000000,
    includedTrafficBytes: 20000000000000, trafficPeriod: null, protection: { delete: false, rebuild: false }, rescueEnabled: false, isoId: null,
    backupWindow: null, volumes: [201], privateNetworks: [{ id: 301, ip: '10.0.1.2' }], firewalls: [{ id: 401, status: 'applied' }], floatingIps: [] },
  billing: { subscriptionId: offerId, state: 'active', period: 'HOURLY', customerPriceRial: 36000, nextInvoiceAt: '2026-11-14T10:00:00Z', currentPeriodEnd: '2026-11-14T10:00:00Z', autoRenew: true, futureDebits: 'normal', refundPolicy: 'no_automatic_proration', providerQuotedRate: { currency: 'EUR', amountCents: .52, period: 'HOURLY', observedAt: '2026-11-14T08:00:00Z' } },
  capabilities: { power: true, resize: true, rebuild: true, resetPassword: true, console: false, rescue: true, protection: true, iso: false, snapshots: false, backups: false, volumes: false, networkMutations: false, unavailableReason: 'عملیات منابع جانبی به ثبت مالکیت و تعرفهٔ مستقل نیاز دارد.' },
  operations: [], credentials: [],
}
export function serverUxFixture(path) {
  if (path === '/auth/me') return { data: { id: 'preview-server-user', email: 'preview@example.test', firstName: 'کاربر آزمایشی', role: 'user', status: 'active' } }
  if (path === '/integration/status') return { data: { enabled: false, linked: false } }
  if (path === '/servers') return { data: [pendingServer, readyServer] }
  if (path === `/servers/provisioning/${pendingOrderId}`) return { data: pendingServer }
  if (path === `/servers/${serverId}/management`) return { data: detailServer }
  if (path === `/servers/${serverId}/images`) return { data: [{ id: '11', name: 'Ubuntu 24.04' }, { id: '12', name: 'Debian 12' }] }
  if (path === `/servers/${serverId}/resize-options`) return { data: [{ offerId, type: 'CX33', architecture: 'x86', storageType: 'local', vcpu: 4, memoryMb: 8192, diskGb: 80, available: true }] }
  if (path === `/servers/${serverId}/metrics`) return { data: { start: '2026-11-14T08:00:00Z', end: '2026-11-14T09:00:00Z', step: 60,
    series: { cpu: Array.from({ length: 12 }, (_, i) => [1794643200 + i * 300, 15 + i % 4 * 6]), 'network.0.bandwidth.in': Array.from({ length: 12 }, (_, i) => [1794643200 + i * 300, 30000 + i % 3 * 12000]), 'disk.0.bandwidth.read': Array.from({ length: 12 }, (_, i) => [1794643200 + i * 300, 18000 + i % 4 * 8000]) } } }
  if (path === `/servers/${serverId}/management/actions`) return { data: { id: pendingOrderId, action: 'delete', status: 'queued', actionId: null, createdAt: '2026-11-14T09:00:00Z', updatedAt: '2026-11-14T09:00:00Z', completedAt: null, message: null } }
  return fixture(path)
}
