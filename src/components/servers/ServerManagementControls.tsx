import { useEffect, useRef, useState } from 'react'
import { Power, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/FormControls'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { formatFaDateTime } from '../../lib/format'
import { acknowledgeServerPassword, actionLabels, claimServerPassword, type ManagementAction, type ServerDetail, type ServerOperation } from '../../lib/serverManagement'

export function ServerPowerActionButton({ action, disabled, onClick }: { action: ManagementAction; disabled: boolean; onClick: () => void }) {
  return <Button variant={action === 'power_off' || action === 'reset' ? 'danger' : 'secondary'} className="server-power-action" icon={<Power size={18} />} disabled={disabled} onClick={onClick}>{actionLabels[action]}</Button>
}
export function DestructiveConfirmation({ server, action, busy, error, onClose, onConfirm }: { server: ServerDetail; action: ManagementAction; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState(''), [ack, setAck] = useState(false)
  const destructive = ['delete', 'rebuild'].includes(action)
  const forced = ['power_off', 'reset'].includes(action)
  return <Modal className={`server-management-modal ${action === 'delete' ? 'server-delete-modal' : ''}`} trapFocus open onClose={() => { if (!busy) onClose() }} title={actionLabels[action]} description={`سرور ${server.name} — ${server.providerIdentity}`}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>انصراف</Button><Button variant={destructive || forced ? 'danger' : 'primary'} disabled={busy || !ack || typed !== server.name} onClick={onConfirm}>{busy ? 'در حال ثبت درخواست…' : `تأیید ${actionLabels[action]}`}</Button></>}>
    <div className="server-confirmation">
      {(destructive || forced) && <p className="server-danger-note"><TriangleAlert size={20} />{destructive ? 'این عملیات داده‌های دیسک سرور را از بین می‌برد و بازگشت‌پذیر نیست.' : 'این فرمان بدون انتظار برای خاموش‌شدن نرم سیستم‌عامل اجرا می‌شود و ممکن است داده‌های ذخیره‌نشده از بین بروند.'}</p>}
      {action === 'delete' && <p className="server-notice">تمدید و برداشت‌های آیندهٔ همین سرور فقط پس از تأیید حذف در Hetzner به‌طور نهایی متوقف می‌شوند. منابع مستقل مانند Volume، Snapshot و IP ممکن است باقی بمانند. برای دورهٔ پیش‌پرداخت، بازپرداخت خودکار انجام نمی‌شود.</p>}
      <Input autoComplete="off" label={`برای تأیید، ${server.name} را دقیق تایپ کنید`} value={typed} onChange={event => setTyped(event.target.value)} disabled={busy} dir="ltr" />
      <label className="server-checkbox"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} disabled={busy} />پیامدهای این عملیات روی سرور مشخص‌شده را می‌پذیرم.</label>
      {error && <p role="alert" className="server-danger-note">{error}</p>}
    </div>
  </Modal>
}
const operationLabels = { queued: 'در صف', dispatching: 'در حال ارسال', provider_accepted: 'پذیرفته‌شده توسط Hetzner', confirmed: 'تأیید نهایی', outcome_unknown: 'نتیجه نامشخص', failed: 'ناموفق' }
export function ServerOperationStatus({ operation }: { operation: ServerOperation }) {
  return <article className="server-operation" role="status"><div><strong>{actionLabels[operation.action] ?? 'عملیات سرور'}</strong><span className={`server-lifecycle server-lifecycle--${operation.status === 'confirmed' ? 'ready' : operation.status === 'failed' ? 'failed' : operation.status === 'outcome_unknown' ? 'outcome_unknown' : 'provisioning'}`}>{operationLabels[operation.status]}</span></div>
    <p>شناسه عملیات: <bdi>{operation.id}</bdi>{operation.actionId ? <> · Action ID: <bdi>{operation.actionId}</bdi></> : null}</p><small>{formatFaDateTime(operation.updatedAt)}</small>{operation.message && <p>{operation.message}</p>}
  </article>
}
export function ServerBillingTerminationState({ server }: { server: ServerDetail }) {
  return <Card className="server-billing-termination"><h3>وضعیت پایان اشتراک</h3><strong>{server.billing.futureDebits === 'stopped' ? 'حذف قطعی تأیید شد؛ برداشت‌های آینده متوقف‌اند.' : server.billing.futureDebits === 'held_pending_confirmation' ? 'نتیجهٔ حذف هنوز نهایی نیست؛ تمدیدهای جدید موقتاً نگه داشته شده‌اند.' : 'اشتراک طبق دورهٔ خریداری‌شده محاسبه می‌شود.'}</strong><p>سوابق مالی قبلی حفظ می‌شوند. خاموش‌کردن VM هزینهٔ ارائه‌دهنده را متوقف نمی‌کند.</p></Card>
}
export function OneTimePassword({ server, operationId, onClose }: { server: ServerDetail; operationId: string; onClose: () => void }) {
  const [secret, setSecret] = useState<{ password: string; expiresAt: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!secret) return
    const clear = () => { setSecret(null); onClose() }
    const hide = () => { if (document.visibilityState === 'hidden') clear() }
    const timer = window.setTimeout(clear, Math.max(0, new Date(secret.expiresAt).getTime() - Date.now()))
    document.addEventListener('visibilitychange', hide)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', hide) }
  }, [secret, onClose])
  const claim = async () => {
    if (busy) return; setBusy(true)
    try { const result = await claimServerPassword(server.id, operationId); if (mounted.current) { if (document.visibilityState === 'hidden') onClose(); else setSecret(result) } }
    catch { if (mounted.current) setError('رمز قابل دریافت نیست، قبلاً نمایش داده شده یا عملیات هنوز تأیید نشده است.') }
    finally { if (mounted.current) setBusy(false) }
  }
  return <Modal className="server-management-modal" trapFocus open onClose={onClose} title="رمز جدید root — فقط یک‌بار" description="این مقدار تنها در نشست فعلی و برای مدت کوتاه نمایش داده می‌شود.">
    <p>رمز را در محل امن نگه دارید. پس از بستن این پنجره یا خروج از تب، نمایش دوباره ممکن نیست.</p>
    {secret ? <><output className="server-password" dir="ltr">{secret.password}</output><div className="server-inline-actions"><Button onClick={() => { void navigator.clipboard.writeText(secret.password).catch(() => setError('کپی خودکار در این مرورگر ممکن نیست.')) }}>کپی رمز</Button><Button variant="secondary" onClick={() => { setSecret(null); void acknowledgeServerPassword(server.id, operationId); onClose() }}>مشاهده و دریافت شد</Button></div></> : <Button disabled={busy} onClick={claim}>دریافت امن رمز</Button>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}
