import { LoaderCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { lifecycleLabels, serverAddressUnavailable } from '../../lib/serverLifecycle'
import type { Server, ServerLifecycle } from '../../lib/types'
import { CopyableIp } from '../ui/CopyableIp'

export function LifecycleBadge({ state }: { state: ServerLifecycle }) {
  const busy = state === 'queued' || state === 'provisioning' || state === 'deleting'
  return <span className={`server-lifecycle server-lifecycle--${state}`} role="status" aria-live="polite">
    {busy && <LoaderCircle size={16} className="server-lifecycle-spinner" aria-hidden="true" />}{lifecycleLabels[state]}
  </span>
}
export function ServerResourceMetricCard({ label, value }: { label: string; value?: string | null }) {
  return <article className="server-resource-metric"><span>{label}</span><strong>{value || 'در دسترس نیست'}</strong></article>
}
function serverLifecycleState(server: Server): ServerLifecycle {
  return server.lifecycle ?? server.tracking?.state ?? (server.status === 'building' ? 'provisioning' : 'ready')
}
export function ServerStatus({ server }: { server: Server }) {
  const state = serverLifecycleState(server)
  return <><LifecycleBadge state={state} />{state === 'ready' && server.status === 'inactive' && <small>خاموش</small>}</>
}
export function ServerTableRow({ server, onPlatformManage }: { server: Server; onPlatformManage?: () => void }) {
  const state = serverLifecycleState(server)
  const ready = state === 'ready'
  const addressUnavailable = serverAddressUnavailable(server)
  const inspectable = ready || ['delete_failed', 'deletion_requested', 'deleting', 'terminated'].includes(state)
  return <tr className={`server-table-row${!ready ? ' server-table-row--pending' : ''}`}>
    <td><strong>{server.name}</strong><small>{server.datacenter || 'در حال دریافت'}{server.os ? ` · ${server.os}` : ''}</small></td>
    <td data-label="وضعیت"><ServerStatus server={server} /></td>
    <td data-label="منابع">{[server.cpu, server.ram, server.disk].filter(Boolean).join(' · ') || 'در حال دریافت'}</td>
    <td data-label="آدرس‌های آی‌پی"><CopyableIp value={server.ip} unavailableReason={addressUnavailable} />{!addressUnavailable && server.ipv6 && <CopyableIp value={server.ipv6} />}</td>
    <td>{(server.platformServerId ? ready : inspectable) ? server.platformServerId
      ? <button className="button button--secondary button--sm" onClick={onPlatformManage} disabled={!onPlatformManage}>مدیریت و نتیجه عملیات</button>
      : <Link className="button button--secondary button--sm" to={`/servers/${server.id}`}>مشاهده جزئیات</Link>
      : server.tracking?.failure ? <div className="server-provisioning-failure">
        <p>{server.tracking.failure.message}</p>
        <p>{server.tracking.failure.billing === 'refunded' ? 'مبلغ پرداخت‌شده به کیف پول بازگردانده شد.'
          : server.tracking.failure.billing === 'not_charged' ? 'مبلغی بابت این سفارش از کیف پول کسر نشده است.' : 'مبلغ کسرشده هنوز بازگردانده نشده و نیازمند پیگیری است.'}</p>
        <p>{server.tracking.failure.nextStep}</p>
        <small>شمارهٔ پیگیری: <bdi>{server.tracking.failure.reference}</bdi></small>
        <Link className="text-link" to="/tickets">پیگیری از پشتیبانی</Link>
        {server.tracking.failure.canChooseAlternative && <Link className="text-link" to="/servers/create">انتخاب پلن یا دیتاسنتر دیگر</Link>}
      </div> : <span className="server-tracking-hint">{server.tracking ? `پیگیری ${server.tracking.reference.slice(0, 8)}` : 'در انتظار اطلاعات معتبر'}</span>}</td>
  </tr>
}
