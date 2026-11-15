import { Fragment, useId, useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { lifecycleLabels, serverAddressUnavailable } from '../../lib/serverLifecycle'
import type { Server, ServerLifecycle } from '../../lib/types'
import { CopyableIp } from '../ui/CopyableIp'
import { CopyableServerReference, FailureDetailsPanel } from './FailureDetailsPanel'

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
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const state = serverLifecycleState(server)
  const ready = state === 'ready'
  const missingResource = state === 'queued' || state === 'provisioning' ? 'در حال دریافت' : 'در دسترس نیست'
  const resources = [server.cpu, server.ram, server.disk].filter(Boolean).join(' · ') || missingResource
  const addressUnavailable = serverAddressUnavailable({ ...server, lifecycle: state })
  const inspectable = ready || ['delete_failed', 'deletion_requested', 'deleting', 'terminated'].includes(state)
  const canInspect = server.platformServerId ? ready : inspectable
  const failureState = ['failed', 'outcome_unknown', 'requires_review'].includes(state)
  const failure = server.tracking?.failure
  const summary = failure ? ({ capacity_unavailable: 'ظرفیت دیتاسنتر تأیید نشد', quota_exceeded: 'سهمیهٔ ساخت سرور کافی نیست', provider_rejected: 'درخواست ساخت تأیید نشد', outcome_unknown: 'نتیجهٔ ساخت در حال بررسی است' })[failure.code] : undefined
  const identifier = server.platformServerId || server.tracking?.serverId || server.serverId
  return <Fragment><tr className={`server-table-row${!ready ? ' server-table-row--pending' : ''}${failureState ? ' server-table-row--failure' : ''}${expanded ? ' server-table-row--expanded' : ''}`}>
    <td><strong><bdi>{server.name}</bdi></strong>{summary && <small className="server-row-summary">{summary}</small>}
      {identifier && <CopyableServerReference key={identifier} value={identifier} label="کپی شناسهٔ سرور" />}</td>
    <td data-label="وضعیت"><ServerStatus server={server} /></td>
    <td data-label="منابع"><span className="server-row-resources"><bdi dir="ltr">{[server.serverType, resources].filter(Boolean).join(' · ')}</bdi></span><small><bdi>{server.datacenter || missingResource}{server.os ? ` · ${server.os}` : ''}</bdi></small></td>
    <td data-label="آدرس‌های آی‌پی"><CopyableIp value={server.ip} unavailableReason={addressUnavailable} />{!addressUnavailable && server.ipv6 && <CopyableIp value={server.ipv6} />}</td>
    <td className="server-row-actions">{canInspect ? server.platformServerId
      ? <><button type="button" className="server-list-control" title="مدیریت و نتیجه عملیات" onClick={onPlatformManage} disabled={!onPlatformManage} aria-describedby={!onPlatformManage ? `${id}-unavailable` : undefined}><span className="server-row-action-label">مدیریت و نتیجه عملیات</span></button>
        {!onPlatformManage && <small id={`${id}-unavailable`} title="اتصال به پلتفرم در دسترس نیست">اتصال به پلتفرم در دسترس نیست</small>}</>
      : <Link className="server-list-control" to={`/servers/${server.id}`}>مشاهده جزئیات</Link>
      : <button type="button" id={`${id}-trigger`} className="server-list-control" aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'بستن جزئیات' : failureState ? 'علت خطا و پیگیری' : 'پیگیری وضعیت'}<ChevronDown size={16} aria-hidden="true" /></button>}</td>
  </tr>{!canInspect && <tr className="server-failure-details-row" hidden={!expanded} id={`${id}-details`} aria-labelledby={`${id}-trigger`}>
    <td colSpan={5}><FailureDetailsPanel server={server} failureState={failureState} /></td>
  </tr>}</Fragment>
}
