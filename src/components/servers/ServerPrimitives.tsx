import { LoaderCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { lifecycleLabels } from '../../lib/serverLifecycle'
import type { Server, ServerLifecycle } from '../../lib/types'

export function LifecycleBadge({ state }: { state: ServerLifecycle }) {
  const busy = state === 'queued' || state === 'provisioning' || state === 'deleting'
  return <span className={`server-lifecycle server-lifecycle--${state}`} role="status" aria-live="polite">
    {busy && <LoaderCircle size={16} className="server-lifecycle-spinner" aria-hidden="true" />}{lifecycleLabels[state]}
  </span>
}
export function ServerResourceMetricCard({ label, value }: { label: string; value?: string | null }) {
  return <article className="server-resource-metric"><span>{label}</span><strong>{value || 'در دسترس نیست'}</strong></article>
}
export function ServerTableRow({ server, onPlatformManage }: { server: Server; onPlatformManage?: () => void }) {
  const state = server.lifecycle ?? server.tracking?.state ?? (server.status === 'building' ? 'provisioning' : 'ready')
  const ready = state === 'ready'
  const inspectable = ready || ['delete_failed', 'deletion_requested', 'deleting', 'terminated'].includes(state)
  return <tr className={`server-table-row${!ready ? ' server-table-row--pending' : ''}`}>
    <td><strong>{server.name}</strong><small>{server.datacenter || 'در حال دریافت'}{server.os ? ` · ${server.os}` : ''}</small></td>
    <td data-label="وضعیت"><LifecycleBadge state={state} />{ready && server.status === 'inactive' && <small>خاموش</small>}</td>
    <td data-label="منابع">{[server.cpu, server.ram, server.disk].filter(Boolean).join(' · ') || 'در حال دریافت'}</td>
    <td data-label="IPv4"><bdi>{server.ip || 'در حال دریافت'}</bdi></td>
    <td>{(server.platformServerId ? ready : inspectable) ? server.platformServerId
      ? <button className="button button--secondary button--sm" onClick={onPlatformManage} disabled={!onPlatformManage}>مدیریت و نتیجه عملیات</button>
      : <Link className="button button--secondary button--sm" to={`/servers/${server.id}`}>مشاهده جزئیات</Link>
      : <span className="server-tracking-hint">{server.tracking ? `پیگیری ${server.tracking.reference.slice(0, 8)}` : 'در انتظار اطلاعات معتبر'}</span>}</td>
  </tr>
}
