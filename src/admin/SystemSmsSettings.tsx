import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/apiClient'
import { useApiQuery } from '../hooks/useApiQuery'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/FormControls'
import { Modal } from '../components/ui/Modal'

interface SmsRow {
  key: string; name: string; group: string; event: string; enabled: boolean; version: number
  approval: string; ready: boolean; blocked: string | null; pattern: string; sample: string; variables: string[]
  primaryLine: string; fallbackConfigured: boolean
  history: Array<{ id: string; eventId: string; status: string; maskedRecipient: string; segments: number; createdAt: string }>
}
const labels: Record<string, string> = {
  'approved-pattern': 'الگوی پویا تأیید شده (تأیید مالک)', 'approved-sample': 'فقط مثال ثابت تأیید شده', unknown: 'نامشخص', rejected: 'رد شده',
  skipped_disabled: 'خاموش؛ ارسال نمی‌شود', blocked_approval: 'مسدود: تأیید الگوی پویا موجود نیست', blocked_approval_revision: 'مسدود: متن الگو تغییر کرده و تأیید مجدد لازم است', development: 'شبیه‌سازی توسعه؛ پیامک واقعی ارسال نشده', blocked_configuration: 'مسدود: سرویس ارسال آماده نیست',
  blocked_not_implemented: 'مسدود: مسیر رویداد آماده نیست', skipped_recipient: 'شمارهٔ تأییدشده موجود نیست یا تغییر کرده', blocked_render: 'متغیر نامعتبر',
  pending: 'در صف', sending: 'در حال ارسال', accepted: 'پذیرفته‌شده توسط پارس‌گرین؛ تحویل گوشی تأیید نشده',
}
export function SystemSmsSettings() {
  const query = useApiQuery(async () => (await apiGet<{ data: SmsRow[] }>('/admin/settings/sms')).data)
  const [editing, setEditing] = useState<SmsRow | null>(null)
  const [enabled, setEnabled] = useState(false), [approval, setApproval] = useState('')
  const [password, setPassword] = useState(''), [totp, setTotp] = useState(''), [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [serverId, setServerId] = useState(''), [note, setNote] = useState(''), [incidentResult, setIncidentResult] = useState('')
  function edit(row: SmsRow) { setEditing(row); setEnabled(row.enabled); setApproval(row.approval); setPassword(''); setTotp(''); setConfirmation(''); setError('') }
  async function save() {
    if (!editing || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      await apiPost('/admin/settings/sms/' + editing.key, { enabled, version: editing.version, confirm: true,
        ...(approval !== editing.approval || editing.blocked === 'blocked_approval_revision' ? { approval } : {}), ...(password ? { password } : {}), ...(totp ? { totp } : {}), ...(confirmation ? { confirmation } : {}) })
      setEditing(null); setPassword(''); setTotp(''); query.refetch()
    } catch (e) { setError(e instanceof Error ? e.message : 'ذخیره نشد؛ دوباره دریافت کنید') }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function incident(resolved: boolean) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setIncidentResult('')
    try { await apiPost('/admin/settings/sms/incidents/' + serverId, { resolved, note, confirm: true }); setIncidentResult('وضعیت اختلال ثبت شد؛ ارسال تابع تنظیمات مستقل اعلان است.'); query.refetch() }
    catch (e) { setIncidentResult(e instanceof Error ? e.message : 'ثبت نشد') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const sensitive = editing && ((editing.group === 'احراز هویت' && !enabled) || approval !== editing.approval || editing.blocked === 'blocked_approval_revision')
  return <div className="form-stack" dir="rtl">
    <h2>پیامک‌های خدماتی پارس‌گرین</h2>
    <p>اولویت خط اختصاصی ۹۹۹۸۸۸۳۵۱۱، سپس خط خدماتی قبلی. هر اعلان مستقل است. ثبت الگو، تأیید پویا و روشن‌بودن سه وضعیت جدا هستند. وضعیت تحویل به گوشی از این API دریافت نمی‌شود.</p>
    <p>رویدادهای خاموش بعداً ارسال نمی‌شوند. تغییر کانال OTP هرگز تأیید هویت را حذف نمی‌کند؛ ورود و بازیابی ایمیلی مسیر جایگزین است.</p>
    <Link to="../logs">سوابق ممیزی و تغییر تنظیمات</Link>
    {query.loading ? <p role="status">در حال دریافت تنظیمات…</p> : query.error ? <div role="alert"><p>{query.error}</p><Button onClick={query.refetch}>دریافت دوباره</Button></div> : null}
    {query.data?.map(row => <section className="card form-stack" key={row.key}>
      <h3>{row.group} / {row.name}</h3><code dir="ltr">{row.key} · {row.event}</code>
      <p>تنظیم ذخیره‌شده: <strong>{row.enabled ? 'روشن' : 'خاموش'}</strong> · نسخه {row.version} · مسیر رویداد: {row.ready ? 'متصل' : 'آماده نیست'}</p>
      <p>الگو ثبت شده · {labels[row.approval] || row.approval} · {row.blocked ? labels[row.blocked] || row.blocked : 'آمادهٔ ارسال هنگام رویداد'}</p>
      <p>خط اصلی: <bdi>{row.primaryLine}</bdi> · مسیر جایگزین: {row.fallbackConfigured ? 'پیکربندی شده' : 'پیکربندی نشده'}</p>
      <pre className="sms-pattern">{row.pattern}</pre><p>مثال ساختگی: {row.sample}</p><p>متغیرها: <bdi>{row.variables.join('، ') || 'ندارد'}</bdi></p>
      <Button variant="secondary" onClick={() => edit(row)}>تغییر تنظیم {row.name}</Button>
      {row.history.length ? <details><summary>آخرین نتیجه‌ها و تاریخچهٔ امن</summary><ul>{row.history.map(h => <li key={h.id}><time>{new Date(h.createdAt).toLocaleString('fa-IR')}</time> — {labels[h.status] || h.status} — <bdi>{h.maskedRecipient || 'بدون گیرنده'}</bdi> — {h.segments} قطعه <code>{h.eventId}</code></li>)}</ul></details> : <p>هنوز رویدادی ثبت نشده است.</p>}
    </section>)}
    <section className="card form-stack"><h3>ثبت اختلال تأییدشدهٔ سرویس</h3><p>فقط اختلالی را که بررسی کرده‌اید ثبت کنید. هر سرور یک اختلال باز دارد و رفع اختلال باید به همان رکورد متصل باشد.</p>
      <Input label="شناسهٔ سرور سایت (UUID)" value={serverId} dir="ltr" onChange={e => setServerId(e.target.value)} /><Input label="شرح بررسی مدیر" value={note} onChange={e => setNote(e.target.value)} />
      <Button disabled={busy || !serverId || !note} onClick={() => incident(false)}>تأیید و ثبت اختلال</Button><Button disabled={busy || !serverId || !note} onClick={() => incident(true)}>تأیید رفع اختلال</Button><p role="status">{incidentResult}</p>
    </section>
    <Modal open={!!editing} title={'تنظیم ' + (editing?.name ?? '')} onClose={() => { if (!busy) { setEditing(null); setPassword('') } }}>
      <div className="form-stack"><label><input type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} /> ارسال هنگام رویداد فعال باشد</label>
        <label>وضعیت واقعی تأیید پارس‌گرین<select value={approval} disabled={busy} onChange={e => setApproval(e.target.value)}>{['approved-pattern', 'approved-sample', 'unknown', 'rejected'].map(value => <option value={value} key={value}>{labels[value]}</option>)}</select></label>
        {sensitive ? <><p>تغییر حساس: پیش از ثبت تأیید الگوی پویا، تأیید واقعی پنل را بررسی کنید. با خاموش‌کردن OTP، این کانال مسدود می‌شود؛ بازیابی ایمیلی برقرار می‌ماند.</p><Input label="رمز فعلی مدیر" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><Input label="کد برنامهٔ دومرحله‌ای (اگر فعال است)" value={totp} onChange={e => setTotp(e.target.value)} /><Input label="عبارت «تأیید تغییر امنیت پیامک» را وارد کنید" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></> : null}
        {error ? <p role="alert">{error}</p> : null}<Button disabled={busy} onClick={save}>{busy ? 'در حال ذخیره…' : 'ذخیره و تأیید'}</Button><Button variant="secondary" disabled={busy} onClick={query.refetch}>تازه‌کردن داده‌ها</Button>
      </div>
    </Modal>
  </div>
}
