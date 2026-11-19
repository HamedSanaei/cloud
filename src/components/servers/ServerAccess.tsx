import { useId, useState, type ReactNode } from 'react'
import { Button, LinkButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { Select } from '../ui/FormControls'
import { useApiQuery } from '../../hooks/useApiQuery'
import { actionLabels, getServerImages, type ManagementAction, type ServerAccessBlock, type ServerDetail } from '../../lib/serverManagement'
import { formatFaDateTime } from '../../lib/format'

type RecoveryTab = 'operations' | 'network'
type Block = ServerAccessBlock | 'checking' | 'submitting' | 'detail_failed'

const reasons: Record<Block, string> = {
  operation_pending: 'نتیجهٔ عملیات قبلی سرور هنوز مشخص نشده است.',
  deletion_pending: 'درخواست حذف سرور هنوز در حال پیگیری است.',
  server_deleted: 'این سرور حذف شده است.',
  server_not_ready: 'سرور هنوز آمادهٔ مدیریت نیست. پس از آماده‌شدن سرور دوباره بررسی کنید.',
  provider_unavailable: 'دریافت وضعیت سرور از ارائه‌دهنده فعلاً ممکن نیست.',
  provider_access_denied: 'دسترسی به سرور در پروژهٔ ارائه‌دهنده تأیید نشد. برای بررسی دسترسی با پشتیبانی تماس بگیرید.',
  unsupported: 'ارائه‌دهنده یا پروژهٔ این سرور از این عملیات پشتیبانی نمی‌کند.',
  rebuild_protected: 'حفاظت نصب مجدد (Rebuild) فعال است. تغییر حفاظت را از بخش شبکه جداگانه تأیید کنید.',
  checking: 'در حال بررسی وضعیت سرور…',
  submitting: 'در حال ثبت درخواست عملیات سرور…',
  detail_failed: 'دریافت آخرین وضعیت سرور ناموفق بود. برای ادامه دوباره بررسی کنید.',
}

interface AccessProps {
  server: ServerDetail
  busy: boolean
  loading: boolean
  stale: boolean
  ask: (action: ManagementAction, input?: Record<string, unknown>) => void
  reveal: (id: string) => void
  recheck: () => void
  openTab: (tab: RecoveryTab) => void
}

export function ServerAccess({ server, busy, loading, stale, ask, reveal, recheck, openTab }: AccessProps) {
  const rebuildReason = useId(), passwordReason = useId()
  const pending = server.operations.find(op => op.status !== 'confirmed' && op.status !== 'failed')
  const fallback = server.lifecycle === 'terminated' ? 'server_deleted'
    : ['deletion_requested', 'deleting'].includes(server.lifecycle) ? 'deletion_pending'
      : pending ? 'operation_pending' : !['ready', 'delete_failed'].includes(server.lifecycle) ? 'server_not_ready'
        : !server.providerAvailable ? 'provider_unavailable' : null
  const localBlock = busy ? 'submitting' : stale ? 'detail_failed' : loading ? 'checking' : null
  const eligibility = server.accessEligibility ?? {
    rebuild: fallback ?? (!server.capabilities.rebuild ? 'unsupported' : server.facts?.protection?.rebuild === true ? 'rebuild_protected' : null),
    resetPassword: fallback ?? (!server.capabilities.resetPassword ? 'unsupported' : null),
  }
  const rebuildBlock = eligibility.rebuild ?? localBlock
  const passwordBlock = eligibility.resetPassword ?? localBlock
  const notice = (block: Block, id: string) => <AccessNotice id={id} block={block} pending={pending}
    loading={loading} recheck={recheck} openTab={openTab} />

  return <div className="server-detail-columns">
    <Card>
      <h2>نصب مجدد سیستم‌عامل</h2>
      <RebuildControls serverId={server.id} eligible={!eligibility.rebuild} ask={ask} reasonId={rebuildReason}
        notice={rebuildBlock ? notice(rebuildBlock, rebuildReason) : null} />
    </Card>
    <Card className="server-root-credential">
      <h2>رمز عبور root</h2>
      <div><p>رمز فعلی قابل بازیابی نیست.</p>
        <Button disabled={!!passwordBlock} aria-describedby={passwordBlock ? passwordReason : undefined} onClick={() => ask('reset_password')}>بازنشانی رمز عبور</Button>
      </div>
      {passwordBlock ? notice(passwordBlock, passwordReason)
        : <p className="server-notice">رمز جدید پس از تأیید عملیات، تنها در نشست درخواست‌کننده و فقط یک‌بار قابل دریافت است.</p>}
      <ServerCredentialList server={server} reveal={reveal} />
    </Card>
  </div>
}

export function ServerCredentialList({ server, reveal, rescueOnly = false }: { server: ServerDetail; reveal: (id: string) => void; rescueOnly?: boolean }) {
  const operations = server.credentials.filter(secret => !secret.claimedAt && !secret.acknowledgedAt && secret.operationId)
    .flatMap(secret => {
      const operation = server.operations.find(op => op.id === secret.operationId && op.status === 'confirmed')
      return operation && (!rescueOnly || operation.action === 'enable_rescue') ? [operation] : []
    })
  if (!operations.length) return null
  return <div className="server-credential-list"><h3>{rescueOnly ? 'رمز یک‌بارمصرف Rescue' : 'رمزهای یک‌بارمصرف عملیات'}</h3>{operations.map(operation => {
    const label = operation.action === 'enable_rescue' ? 'دریافت امن رمز Rescue' : `دریافت امن رمز — ${actionLabels[operation.action]}`
    const time = formatFaDateTime(operation.createdAt)
    return <article key={operation.id}><strong>{actionLabels[operation.action]}</strong>
      <p>زمان درخواست: <time dateTime={operation.createdAt}>{time}</time></p><small>شناسهٔ عملیات: <bdi dir="ltr">{operation.id}</bdi></small>
      <Button variant="secondary" aria-label={`${label} — ${time} — ${operation.id}`} onClick={() => reveal(operation.id)}>{label}</Button>
    </article>
  })}</div>
}

function AccessNotice({ id, block, pending, loading, recheck, openTab }: {
  id: string; block: Block; pending: ServerDetail['operations'][number] | undefined
} & Pick<AccessProps, 'loading' | 'recheck' | 'openTab'>) {
  const operations = block === 'operation_pending' || block === 'deletion_pending'
  const canRecheck = !['server_deleted', 'unsupported', 'checking', 'submitting'].includes(block)
  return <div className="server-notice server-access-notice">
    <p id={id} role="status">{block === 'operation_pending' && pending
      ? `نتیجهٔ عملیات «${actionLabels[pending.action] ?? 'عملیات سرور'}» هنوز مشخص نشده است.` : reasons[block]}</p>
    <div className="server-inline-actions">
      {operations && <Button size="sm" variant="secondary" onClick={() => openTab('operations')}>مشاهدهٔ عملیات</Button>}
      {block === 'rebuild_protected' && <Button size="sm" variant="secondary" onClick={() => openTab('network')}>مشاهدهٔ حفاظت سرور</Button>}
      {block === 'provider_access_denied' && <LinkButton size="sm" variant="secondary" to="/tickets">پشتیبانی</LinkButton>}
      {canRecheck && <Button size="sm" variant="secondary" disabled={loading} onClick={recheck}>بررسی دوبارهٔ وضعیت</Button>}
    </div>
  </div>
}

function RebuildControls({ serverId, eligible, ask, reasonId, notice }: {
  serverId: string; eligible: boolean; ask: AccessProps['ask']; reasonId: string; notice: ReactNode
}) {
  const images = useApiQuery(() => eligible ? getServerImages(serverId) : Promise.resolve([]), [serverId, eligible])
  const [selection, setSelection] = useState('')
  const selected = images.data?.find(item => item.id === selection)
  const image = selected?.id ?? ''
  const imageReason = images.loading ? 'در حال دریافت تصاویر مجاز…' : images.error ? 'دریافت تصاویر مجاز ناموفق بود.'
    : !images.data?.length ? 'تصویر سازگار برای این سرور پیدا نشد.' : null
  const description = notice || imageReason ? reasonId : undefined
  return <>
    <Select label="تصویر سیستم‌عامل مجاز" value={image} onChange={event => setSelection(event.target.value)}
      disabled={!!notice || !!imageReason} aria-describedby={description}>
      <option value="">انتخاب سیستم‌عامل</option>
      {eligible && images.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </Select>
    <p className="server-danger-note">تمام داده‌های دیسک سرور حذف می‌شود.</p>
    <Button variant="danger" disabled={!!notice || !!imageReason || !image} aria-describedby={description}
      onClick={() => { if (selected) ask('rebuild', { image: selected.id, imageLabel: selected.name }) }}>نصب مجدد و حذف داده‌ها</Button>
    {notice || (imageReason && <div className="server-notice server-access-notice">
      <p id={reasonId} role="status">{imageReason}</p>
      {!images.loading && <Button size="sm" variant="secondary" onClick={images.refetch}>دریافت دوبارهٔ تصاویر</Button>}
    </div>)}
  </>
}
