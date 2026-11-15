// Synthetic review states only; never loaded by production builds or APIs.
import { readyServer, pendingServer, serverUxFixture } from './server-management-fixtures.mjs'
export const serverListFixtures = [
  ...['refunded', 'captured', 'not_charged'].map((billing, index) => ({ ...pendingServer, id: `order:failed-${index}`, name: `failed-node-${index + 1}`, lifecycle: 'failed',
    cpu: '2 vCPU', ram: '4096 MB', disk: '40 GB', tracking: { ...pendingServer.tracking, reference: `fixture-order-${index}`, state: 'failed',
      failure: { code: 'capacity_unavailable', message: 'ظرفیت دیتاسنتر انتخابی برای ساخت این سرور تأیید نشد. می‌توانید جزئیات را با شناسهٔ پیگیری از پشتیبانی بپرسید.', billing,
        reference: `FIXTURE-ONLY-REFERENCE-${index}`, nextStep: 'برای بررسی نتیجهٔ سفارش با پشتیبانی تماس بگیرید.', canChooseAlternative: billing !== 'captured' } } })),
  { ...pendingServer, id: 'queued-fixture', name: 'queued-node', lifecycle: 'queued', tracking: { ...pendingServer.tracking, orderId: 'queued-fixture', state: 'queued', reference: 'queued-fixture' } },
  pendingServer,
  { ...readyServer, ipv6: '2001:0DB8:0000:0000:0000:0000:0000:0042/128' },
  { ...readyServer, id: 'deleted-fixture', name: 'deleted-node', lifecycle: 'terminated', status: 'inactive', tracking: { ...readyServer.tracking, reference: 'deleted-fixture', state: 'terminated' } },
  { ...readyServer, id: 'delete-failed-fixture', name: 'delete-failed-node', lifecycle: 'delete_failed', tracking: { ...readyServer.tracking, reference: 'delete-failed-fixture', state: 'delete_failed' } },
  { ...readyServer, id: 'legacy-db-fixture', platformServerId: 'platform-fixture-9', name: 'platform-node', tracking: { ...readyServer.tracking, source: 'platform', reference: 'platform-fixture-9', serverId: 'platform-fixture-9' } },
]
export function serverListFixture(path) {
  if (path === '/servers') return { data: serverListFixtures }
  if (path === '/servers/provisioning/queued-fixture') return { data: serverListFixtures[3] }
  return serverUxFixture(path)
}
