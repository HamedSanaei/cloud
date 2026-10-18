import { useCallback, useEffect, useRef, useState } from 'react'
import { platformGet, platformPost } from '../../lib/platformClient'
import { Button } from './Button'
import { Input, Select } from './FormControls'
import { Modal } from './Modal'

interface Machine { server_id: string; display_name?: string; state: string; ip?: string; operating_system?: string }
interface Receipt { id: string; type: string; action?: string; status: string; detail?: string; observedState?: string; updatedAt: string }
interface Pending { action: string; body: Record<string, unknown>; key: string }
const labels: Record<string, string> = { 'power-on': 'روشن کردن', 'power-off': 'خاموش کردن', reboot: 'راه‌اندازی مجدد', reinstall: 'نصب مجدد سیستم‌عامل', 'reset-password': 'بازنشانی رمز', delete: 'حذف سرور', 'ssh-port': 'افزودن پورت SSH' }
const actions: Record<string, string> = { start: 'power-on', stop: 'power-off', reboot: 'reboot', reinstall: 'reinstall', password_reset: 'reset-password', delete: 'delete' }
const statuses: Record<string, string> = { pending: 'در انتظار', running: 'در حال اجرا', success: 'موفق؛ تأیید ارائه‌دهنده', failed: 'ناموفق', outcome_unknown: 'نتیجه نامشخص؛ نیازمند بررسی', dispatch_completed: 'ارسال شد؛ پایان عملیات تأیید نشده' }

/** Lives on the server page, never substitutes for dashboard/finance/storefront. */
export function ServerManagement({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [server, setServer] = useState<Machine | null>(null)
  const [operations, setOperations] = useState<string[]>([])
  const [history, setHistory] = useState<Receipt[]>([])
  const [account, setAccount] = useState<{ superadmin: boolean; testPortManagement: boolean } | null>(null)
  const [images, setImages] = useState<Array<{ ref: string; name: string }>>([])
  const [image, setImage] = useState('')
  const [port, setPort] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [secret, setSecret] = useState<{ claimId: string; username: string; password: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const refresh = useCallback(async () => {
    const [detail, records, actor] = await Promise.all([
      platformGet<{ server: Machine; operations: string[] }>(`/servers/${serverId}`),
      platformGet<Receipt[]>(`/servers/${serverId}/operations`),
      platformGet<{ superadmin: boolean; testPortManagement: boolean }>('/account'),
    ])
    if (mounted.current) { setServer(detail.server); setOperations(detail.operations); setHistory(records); setAccount(actor) }
  }, [serverId])
  const perform = async (work: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'عملیات تکمیل نشد') }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { if (!lock.current && document.visibilityState === 'visible') await refresh() }
      catch { if (!stopped) setError('خواندن وضعیت جدید ممکن نشد؛ عملیات را تکرار نکنید.') }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 15000) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); mounted.current = false }
  }, [refresh])
  const prepare = (action: string) => perform(async () => {
    const key = crypto.randomUUID()
    const body: Record<string, unknown> = action === 'reinstall' ? { image } : action === 'ssh-port' ? { port: Number(port) } : {}
    if (['power-off', 'reinstall', 'reset-password', 'delete', 'ssh-port'].includes(action)) {
      const confirmation = await platformPost<{ confirmationToken: string }>(`/servers/${serverId}/confirmations/${action}`, body, key)
      body.confirmationToken = confirmation.confirmationToken
    }
    setPending({ action, body, key })
  })
  const execute = () => perform(async () => {
    if (!pending) return
    const outcome = await platformPost<{ replayed: boolean; outcome_unknown: boolean }>(`/servers/${serverId}/actions/${pending.action}`, pending.body, pending.key)
    setResult(outcome.outcome_unknown ? 'نتیجه هنوز قطعی نیست؛ وضعیت را بررسی کنید و عملیات را تکرار نکنید.' : outcome.replayed ? 'این درخواست قبلاً ثبت شده است.' : 'درخواست پذیرفته شد؛ نتیجه نهایی پس از تأیید ارائه‌دهنده در سابقه نمایش داده می‌شود.')
    setPending(null); await refresh()
  })
  const sharedTest = server?.ip === '217.20.121.89' && account?.superadmin
  return <>
    <Modal open title={`مدیریت ${server?.display_name ?? 'سرور'}`} onClose={() => { if (!busy && !pending) onClose() }}>
      <div className="form-stack">
        <p dir="ltr">{server?.ip} · {server?.state} · {server?.operating_system}</p>
        {error && <p className="platform-error" role="alert">{error}</p>}{result && <p className="platform-result" role="status">{result}</p>}
        <div className="platform-inline">{operations.filter(op => actions[op] && op !== 'reinstall' && !(sharedTest && op === 'delete')).map(op => <Button key={op} disabled={busy || !!pending} variant={op === 'delete' ? 'danger' : 'secondary'} onClick={() => void prepare(actions[op])}>{labels[actions[op]]}</Button>)}</div>
        {operations.includes('reinstall') && <Button disabled={busy || !!pending} onClick={() => void perform(async () => setImages(await platformGet(`/servers/${serverId}/images`)))}>انتخاب سیستم‌عامل برای نصب مجدد</Button>}
        {images.length > 0 && <div className="platform-inline"><Select label="سیستم‌عامل جدید" value={image} disabled={busy || !!pending} onChange={e => setImage(e.target.value)}><option value="">انتخاب کنید</option>{images.map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}</Select><Button disabled={busy || !!pending || !image} onClick={() => void prepare('reinstall')}>آماده‌سازی نصب مجدد</Button></div>}
        {sharedTest && (account?.testPortManagement ? <div className="platform-inline"><Input label="پورت جدید SSH (۱۰۲۴ تا ۶۵۵۳۵)" type="number" min={1024} max={65535} disabled={busy || !!pending} value={port} onChange={e => setPort(e.target.value)} /><Button disabled={busy || !!pending || !Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535} onClick={() => void prepare('ssh-port')}>آماده‌سازی افزودن پورت</Button></div> : <p>مدیریت پورت نیازمند پیکربندی ابزار امن داخل سرور توسط مدیر است.</p>)}
        <Button disabled={busy || !!pending || !!secret || !server} onClick={() => void perform(async () => setSecret(await platformPost(`/servers/${serverId}/credentials/claim`, {})))}>دریافت رمز یک‌بارمصرف</Button>
        {secret && <div className="platform-result"><p>رمز فقط در حافظه صفحه است؛ آن را در محل امن ذخیره کنید.</p><p dir="ltr">{secret.username}: <code>{secret.password}</code></p><Button disabled={busy} onClick={() => void perform(async () => { await platformPost(`/servers/${serverId}/credentials/ack`, { claimId: secret.claimId }); setSecret(null) })}>ذخیره کردم؛ پاک کردن رمز</Button></div>}
        {pending && <section className="server-confirmation" aria-label="تأیید عملیات سرور">
          <h3>تأیید {labels[pending.action]}</h3><p>نصب مجدد و حذف، داده‌های سرور را پاک می‌کنند. پورت جدید، پورت قبلی را حذف نمی‌کند.</p>
          <p dir="ltr">{server?.ip} {pending.body.image ? String(pending.body.image) : ''} {pending.body.port ? `SSH: ${String(pending.body.port)}` : ''}</p>
          <div className="platform-inline"><Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>انصراف</Button><Button variant="danger" disabled={busy} onClick={() => void execute()}>تأیید اجرای عملیات</Button></div>
        </section>}
        <h3>سابقه و نتیجه عملیات</h3><p className="muted-copy">پذیرش درخواست به معنی موفقیت نهایی نیست. نتیجه واقعی و مجوزهای سرور خودکار تازه می‌شوند.</p>
        <Button variant="secondary" disabled={busy} onClick={() => void perform(refresh)}>تازه‌سازی وضعیت</Button>
        <div className="platform-history">{history.map(item => <article key={item.id}><span>{item.action ? labels[actions[item.action] ?? item.action] ?? item.action : item.type} · {statuses[item.status] ?? item.status}{item.observedState ? ` · ${item.observedState}` : ''}{item.detail ? ` · ${item.detail}` : ''}</span><time>{new Date(item.updatedAt).toLocaleString('fa-IR')}</time></article>)}</div>
      </div>
    </Modal>
  </>
}
