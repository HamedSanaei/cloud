import { createContext, useContext, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { CreditCard, Database, FileClock, Settings2, ShieldCheck, WalletCards } from 'lucide-react'
import { apiGet, apiPost, systemBinary } from '../lib/apiClient'
import { useApiQuery } from '../hooks/useApiQuery'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { Modal } from '../components/ui/Modal'
import './system-settings.css'

const base = '/admin/settings'
type RunSensitive = (action: string, payload: unknown, summary: string, execute: (proof: string) => Promise<void>) => void
const ActionContext = createContext<RunSensitive>(() => undefined)
const useSensitive = () => useContext(ActionContext)
const post = async <T,>(url: string, data: unknown, key?: string) => (await apiPost<{ data: T }>(base + url, data, key ? { headers: { 'idempotency-key': key } } : undefined)).data
const get = async <T,>(url: string) => (await apiGet<{ data: T }>(base + url)).data
const errorText = (e: unknown) => e instanceof Error ? e.message : 'عملیات تکمیل نشد.'
const rial = (value: number) => new Intl.NumberFormat('fa-IR').format(value) + ' ریال'
const countLabel: Record<string,string> = { users: 'کاربران', tickets: 'تیکت‌ها', wallets: 'کیف پول‌ها', wallet_transactions: 'گردش‌های مالی', orders: 'سفارش‌ها', order_items: 'اقلام سفارش', order_events: 'رویدادهای سفارش', invoices: 'فاکتورها', invoice_items: 'اقلام فاکتور', subscriptions: 'اشتراک‌ها', subscription_events: 'رویدادهای اشتراک', renewal_attempts: 'تلاش‌های تمدید', servers: 'سرورها', provider_operations: 'عملیات سرویس‌دهنده', wallet_payments: 'پرداخت‌ها', gateway_credentials: 'نسخه‌های مرچنت', admin_adjustments: 'تعدیل‌های مالی', pricing_rules: 'قواعد قیمت‌گذاری' }
const label = (value: string) => ({ active: 'فعال', disabled: 'غیرفعال', pending: 'در انتظار', backup: 'پشتیبان', upload: 'فایل بارگذاری‌شده', rehearsal: 'آزمایش بازیابی', restore: 'بازیابی', completed: 'تکمیل‌شده', failed: 'ناموفق', running: 'در حال اجرا', queued: 'در صف', awaiting_approval: 'در انتظار مدیر دوم', interrupted: 'قطع‌شده؛ نیازمند بررسی', rolled_back: 'بازگردانی ایمن انجام شد', deleted: 'حذف‌شده', preflight: 'پیش‌بررسی', dumping: 'تهیه پشتیبان', encrypted: 'رمزگذاری‌شده', authenticated: 'اصالت تأیید شد', verified: 'صحت‌سنجی موفق', pre_backup: 'پشتیبان پیش از بازیابی', restoring: 'در حال بازیابی', rollback: 'بازگردانی ایمن', retention_expired: 'پایان دوره نگهداری' } as Record<string,string>)[value] || value
function date(value: string) { return new Date(value).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) }
interface Capabilities { allowed: boolean; encryptionReady: boolean; backupsEnabled: boolean; restoreEnabled: boolean; maxUploadBytes: number; dualApprovalRial: number; mfaEnabled: boolean }
function SecureActions({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ action: string; payload: unknown; summary: string; execute: (proof: string) => Promise<void> } | null>(null)
  const [password, setPassword] = useState(''), [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const clear = () => { setPassword(''); setCode(''); setError(''); setPending(null) }
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!pending || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const { proof } = await post<{ proof: string }>('/authorize', { action: pending.action, payload: pending.payload, password, code })
      setPassword(''); setCode(''); await pending.execute(proof); clear()
    } catch (e) { setError(errorText(e)) } finally { lock.current = false; setBusy(false) }
  }
  return <ActionContext.Provider value={(action, payload, summary, execute) => { if (!lock.current) { setPassword(''); setCode(''); setError(''); setPending({ action, payload, summary, execute }) } }}>{children}
    <Modal trapFocus open={!!pending} onClose={() => { if (!busy) clear() }} title="تأیید امن عملیات" description="این تأیید فقط برای همین عملیات و همین نشست معتبر است و یک بار مصرف می‌شود.">
      <form className="form-stack" onSubmit={submit}><p className="system-review">{pending?.summary}</p>
        <Input label="رمز عبور فعلی مدیر" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
        <Input label="کد برنامهٔ احراز هویت" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value)} />
        {error ? <p role="alert" className="system-error">{error}</p> : null}<Button type="submit" disabled={busy}>{busy ? 'در حال بررسی…' : 'تأیید و اجرا'}</Button>
      </form>
    </Modal>
  </ActionContext.Provider>
}
function MfaEnrollment({ onEnabled }: { onEnabled: () => void }) {
  const [password, setPassword] = useState(''), [code, setCode] = useState(''), [secret, setSecret] = useState<{ secret: string; recoveryCodes: string[] } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return <Card><h2><ShieldCheck size={22} /> فعال‌سازی تأیید امنیتی مدیریت</h2><p>برای تغییرات حساس، رمز عبور و کد برنامهٔ احراز هویت لازم است. کلید را فقط در برنامهٔ شخصی خود ثبت و کدهای بازیابی را در محل امن نگهداری کنید.</p>
    <form className="form-stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try {
      if (!secret) setSecret(await post('/mfa/setup', { password }))
      else { await post('/mfa/enable', { password, code }); setSecret(null); setPassword(''); setCode(''); onEnabled() }
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }}>
      <Input label="رمز عبور فعلی مدیر" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      {secret ? <><p>کلید ثبت دستی:</p><code dir="ltr" className="system-secret">{secret.secret}</code><p>کدهای بازیابی؛ فقط همین بار نمایش داده می‌شوند:</p><pre dir="ltr" className="system-secret">{secret.recoveryCodes.join('\n')}</pre><Input label="کد برنامهٔ احراز هویت" required inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={e => setCode(e.target.value)} /></> : null}
      {error ? <p role="alert">{error}</p> : null}<Button type="submit" disabled={busy}>{secret ? 'تأیید فعال‌سازی' : 'ایجاد کلید امنیتی'}</Button>
    </form></Card>
}
export function SystemSettingsLayout() {
  const capabilities = useApiQuery(() => get<Capabilities>('/capabilities'))
  return <div className="page-stack system-settings"><header><h1><Settings2 /> تنظیمات فروشگاه</h1><p>درگاه، رویدادها، پشتیبان‌گیری و عملیات مالی امن</p></header>
    <nav className="system-tabs" aria-label="بخش‌های تنظیمات فروشگاه">{[
      { to: 'gateway', label: 'درگاه‌ها', icon: CreditCard }, { to: 'logs', label: 'لاگ‌ها', icon: FileClock },
      { to: 'backups', label: 'پشتیبان‌گیری و بازیابی', icon: Database }, { to: 'finance', label: 'عملیات مالی کاربران', icon: WalletCards },
    ].map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={19} />{label}</NavLink>)}</nav>
    {capabilities.loading ? <p role="status">در حال بررسی دسترسی…</p> : capabilities.error ? <p role="alert">{capabilities.error}</p> : !capabilities.data?.allowed ? <Card><h2>دسترسی مدیریت مجاز نیست</h2><p>این بخش فقط برای حساب‌های مدیر فعال فروشگاه قابل استفاده است.</p></Card> : !capabilities.data.mfaEnabled ? <MfaEnrollment onEnabled={capabilities.refetch} /> : <SecureActions>{!capabilities.data.encryptionReady ? <Card><h2>کلید رمزگذاری آماده نیست</h2><p>برای تغییر مرچنت TabaPay باید STORE_SECRET_KEY مستقل و پایدار در تنظیمات محافظت‌شده سرور ثبت شود. سایر بخش‌های مدیریتی قابل مشاهده و استفاده هستند و عملیات Backup نیز به تنظیمات مستقل خود نیاز دارد.</p></Card> : null}<Outlet context={capabilities.data} /></SecureActions>}
  </div>
}
interface Gateway { enabled: boolean; sandbox: boolean; configured: boolean; source: string; maskedMerchant: string; domain: string; callbackUrl: string; returnUrl: string; versions: Array<{ fingerprint: string; suffix: string; createdAt: string }> }
export function SystemGateway() {
  const capabilities = useOutletContext<Capabilities>()
  const query = useApiQuery(() => get<Gateway>('/gateway')), sensitive = useSensitive()
  const [merchant, setMerchant] = useState(''), [version, setVersion] = useState(''), [enabled, setEnabled] = useState<boolean | null>(null), [sandbox, setSandbox] = useState<boolean | null>(null)
  const [notice, setNotice] = useState('')
  const data = query.data
  if (query.loading) return <p role="status">در حال دریافت درگاه…</p>
  if (!data || query.error) return <p role="alert">{query.error || 'درگاه دریافت نشد.'}</p>
  return <div className="system-columns"><Card><h2>درگاه تاباپی</h2><dl className="system-facts"><dt>وضعیت</dt><dd>{data.enabled ? 'فعال' : 'غیرفعال'} · {data.sandbox ? 'آزمایشی' : 'عملیاتی'}</dd><dt>مرچنت</dt><dd dir="ltr">{data.maskedMerchant || 'تنظیم نشده'}</dd><dt>منبع تنظیمات</dt><dd>{data.source === 'store' ? 'تنظیمات رمزگذاری‌شدهٔ فروشگاه' : 'محیط سرور'}</dd><dt>دامنه</dt><dd dir="ltr">{data.domain}</dd><dt>Callback</dt><dd dir="ltr">{data.callbackUrl}</dd><dt>بازگشت</dt><dd dir="ltr">{data.returnUrl}</dd></dl>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); const payload = { enabled: enabled ?? data.enabled, sandbox: sandbox ?? data.sandbox, ...(merchant ? { merchant } : version ? { version } : {}), confirm: true }
      sensitive('gateway.update', payload, `ثبت تنظیمات درگاه برای ${data.domain}؛ نسخه‌های قبلی برای Verify پرداخت‌های قبلی حفظ می‌شوند.`, async proof => { await post('/gateway', { ...payload, proof }); setMerchant(''); setVersion(''); setNotice('تنظیمات بدون Restart اعمال شد.'); query.refetch() }) }}>
      <Toggle label="فعال بودن درگاه برای پرداخت‌های جدید" checked={enabled ?? data.enabled} onChange={setEnabled} /><Toggle label="محیط آزمایشی (فقط توسعه)" checked={sandbox ?? data.sandbox} onChange={setSandbox} />
      <Input label="مرچنت جدید (اختیاری)" type="password" autoComplete="off" placeholder="UUID" value={merchant} onChange={e => { setMerchant(e.target.value.trim()); setVersion('') }} hint="خالی بماند تا اعتبارنامهٔ فعلی حفظ شود؛ مقدار کامل در GET برگردانده نمی‌شود." />
      <Select label="بازگشت به نسخهٔ قبلی" value={version} onChange={e => { setVersion(e.target.value); setMerchant('') }}><option value="">حفظ نسخهٔ فعلی</option>{data.versions.map(v => <option key={v.fingerprint} value={v.fingerprint}>••••{v.suffix} — {date(v.createdAt)}</option>)}</Select>
      <Button type="submit" disabled={!capabilities.encryptionReady}>بازبینی و ثبت امن</Button>
    </form></Card><Card><h2>بررسی اتصال و دامنه</h2><p>تعویض مرچنت، دامنهٔ تأییدشده نزد تاباپی را تغییر نمی‌دهد. پیام خطای مرچنت و عدم تطابق دامنه جداگانه ثبت می‌شود. نبود Referer در مرورگر نیز می‌تواند مانع نمایش فرم درگاه شود.</p>
      <Button variant="secondary" onClick={() => sensitive('gateway.diagnose', { confirm: true }, 'فقط بررسی دسترسی شبکه و تنظیمات؛ هیچ تراکنش مالی ساخته نمی‌شود.', async proof => { const result = await post<{ reachable: boolean; credential: string; message: string }>('/gateway/diagnose', { confirm: true, proof }); setNotice(`دسترسی شبکه: ${result.reachable ? 'برقرار' : 'ناموفق'}؛ قالب مرچنت: ${result.credential === 'invalid_format' ? 'نامعتبر' : 'معتبر، تأیید ارائه‌دهنده انجام نشده'}. ${result.message}`) })}>بررسی بدون تراکنش</Button>
      <p role="status">{notice}</p></Card></div>
}
interface LogEvent { id: string; createdAt: string; level: string; service: string; event: string; actorId: string | null; requestId: string | null; metadata: Record<string, unknown> }
interface Page<T> { items: T[]; total: number; page: number; pages: number }
export function SystemLogs() {
  const [page, setPage] = useState(1), [level, setLevel] = useState(''), [service, setService] = useState(''), [event, setEvent] = useState(''), [actorId, setActorId] = useState(''), [search, setSearch] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [detail, setDetail] = useState<LogEvent | null>(null), [notice, setNotice] = useState('')
  const sensitive = useSensitive(), [filters, setFilters] = useState<Record<string, string | number>>({ level: '', service: '', event: '', actorId: '', search: '' })
  const query = useApiQuery(() => get<Page<LogEvent>>('/logs?' + new URLSearchParams(Object.entries({ ...filters, page, limit: 20 }).map(([k, v]) => [k, String(v)]))), [page, filters])
  return <div className="page-stack"><Card><h2>رویدادهای سیستم و Audit</h2><p>زمان‌ها با منطقهٔ Asia/Tehran نمایش داده می‌شوند. اطلاعات محرمانه و متن خام خطاها حذف شده‌اند؛ جست‌وجو بر اساس نام رخداد یا شناسهٔ درخواست است.</p>
    <form className="system-filter" onSubmit={e => { e.preventDefault(); setPage(1); setFilters({ level, service, event, actorId, search, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}) }) }}>
      <Input label="جست‌وجو" value={search} onChange={e => setSearch(e.target.value)} /><Input label="نوع رخداد" value={event} onChange={e => setEvent(e.target.value)} /><Input label="شناسهٔ کاربر / مدیر" value={actorId} onChange={e => setActorId(e.target.value)} />
      <Select label="شدت" value={level} onChange={e => setLevel(e.target.value)}><option value="">همه</option><option value="info">اطلاعات</option><option value="warn">هشدار</option><option value="error">خطا</option></Select><Select label="سرویس" value={service} onChange={e => setService(e.target.value)}><option value="">همه</option>{['audit', 'api', 'worker', 'cloud-api', 'cloud-server', 'cloud-worker', 'cloud-migrate'].map(s => <option key={s}>{s}</option>)}</Select>
      <Input label="از زمان" type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /><Input label="تا زمان" type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /><Button type="submit">اعمال فیلتر</Button>
    </form>
    <Button variant="secondary" onClick={() => { const payload = { ...filters, page, limit: 20 }; sensitive('logs.export', payload, 'دریافت حداکثر ۱۰۰۰ رخداد پاک‌سازی‌شده با ثبت Audit.', async proof => { const data = await apiPost(base + '/logs/export', { ...payload, proof }); download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'system-events.json'); setNotice('خروجی آماده شد.') }) }}>دریافت خروجی امن</Button>
    {query.error ? <p role="alert">{query.error}</p> : null}{query.loading ? <p role="status">در حال دریافت…</p> : query.data?.items.map(item => <button className="system-log" key={item.id} onClick={() => setDetail(item)}><time>{date(item.createdAt)}</time><strong dir="ltr">{item.event}</strong><span>{item.level} · {item.service}</span><small dir="ltr">{item.requestId || item.actorId}</small></button>)}
    {!query.loading && !query.data?.items.length ? <p>رویدادی با این فیلترها یافت نشد.</p> : null}<Pagination page={page} pages={query.data?.pages ?? 0} setPage={setPage} /><p role="status">{notice}</p>
  </Card><Modal trapFocus open={!!detail} onClose={() => setDetail(null)} title="جزئیات رویداد"><pre className="system-json" dir="ltr">{JSON.stringify(detail, null, 2)}</pre></Modal></div>
}
function Pagination({ page, pages, setPage }: { page: number; pages: number; setPage: (n: number) => void }) { return <div className="system-pagination"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>قبلی</Button><span>صفحهٔ {page} از {Math.max(1, pages)}</span><Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>بعدی</Button></div> }
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }

interface FinancialUser { id: string; name: string; email: string; mobile: string; status: string; wallets: Array<{ id: string; name: string; balanceRial: number }> }
interface Adjustment { ownerEmail?: string; ownerName?: string; walletName?: string; id: string; actorId: string; userId: string; walletId: string; direction: string; amountRial: number; status: string; reason: string; reference: string; beforeRial: number | null; afterRial: number | null; createdAt: string }
export function SystemFinance() {
  const [search, setSearch] = useState(''), [results, setResults] = useState<FinancialUser[]>([]), [user, setUser] = useState<FinancialUser | null>(null), [walletId, setWalletId] = useState(''), [direction, setDirection] = useState('credit'), [amount, setAmount] = useState(''), [reason, setReason] = useState(''), [reference, setReference] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(1)
  const key = useRef(crypto.randomUUID()), sensitive = useSensitive()
  const history = useApiQuery(() => get<Page<Adjustment>>('/finance/adjustments?' + new URLSearchParams({ page: String(page), ...(walletId ? { walletId } : {}) })), [page, walletId])
  const wallet = user?.wallets.find(w => w.id === walletId), value = Number(amount), after = wallet ? wallet.balanceRial + (direction === 'credit' ? 1 : -1) * value : 0
  const changed = () => { key.current = crypto.randomUUID() }
  return <div className="page-stack"><Card><h2>یافتن دقیق حساب</h2><form className="system-search" onSubmit={async e => { e.preventDefault(); setBusy(true); setNotice(''); setUser(null); setWalletId(''); setResults([]); try { const found = await get<FinancialUser[]>('/finance/users?' + new URLSearchParams({ search })); setResults(found); if (!found.length) setNotice('حسابی پیدا نشد.') } catch (e) { setNotice(errorText(e)) } finally { setBusy(false) } }}>
    <Input label="شمارهٔ موبایل یا ایمیل کامل" required value={search} onChange={e => setSearch(e.target.value)} /><Button type="submit" disabled={busy}>جست‌وجوی حساب</Button></form>
    {results.map(item => <button type="button" className={'system-user ' + (user?.id === item.id ? 'is-selected' : '')} aria-pressed={user?.id === item.id} key={item.id} onClick={() => { setUser(item); setWalletId(item.wallets[0]?.id || ''); setPage(1); changed() }}><strong>{item.name || 'بدون نام'} · {label(item.status)}</strong><span dir="ltr">{item.email} · {item.mobile}</span><small dir="ltr">{item.id}</small></button>)}
  </Card>{user ? <Card><h2>تعدیل کیف پول انتخاب‌شده</h2><p>{user.name} · <bdi>{user.email}</bdi></p><p>همهٔ مبالغ این فرم دقیقاً به ریال هستند. تعدیل بزرگ نیاز به تأیید مدیر دوم دارد؛ برداشت نباید پوشش تعهدات فعال را کم کند.</p>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); if (!wallet || !Number.isSafeInteger(value) || value <= 0) return
      const payload = { userId: user.id, walletId, direction, amountRial: value, reason, reference, confirm: true }, requestKey = key.current
      sensitive('wallet.adjust', payload, `${direction === 'credit' ? 'افزایش' : 'کاهش'} ${rial(value)} برای ${user.email}؛ کیف پول ${wallet.name} (${wallet.id})؛ موجودی فعلی ${rial(wallet.balanceRial)} و برآورد پس از عملیات ${rial(after)}. علت: ${reason}؛ پیگیری: ${reference}`, async proof => { const result = await post<Adjustment>('/finance/adjustments', { ...payload, proof }, requestKey); setNotice(result.status === 'completed' ? `عملیات ${result.id} ثبت شد؛ موجودی ${rial(result.afterRial!)}` : `درخواست ${result.id} در انتظار تأیید مدیر دوم است.`); history.refetch() }) }}>
      <Select label="کیف پول" value={walletId} onChange={e => { setWalletId(e.target.value); changed() }}>{user.wallets.map(w => <option key={w.id} value={w.id}>{w.name} — {rial(w.balanceRial)} — {w.id.slice(0, 8)}</option>)}</Select>
      <Select label="نوع تعدیل" value={direction} onChange={e => { setDirection(e.target.value); changed() }}><option value="credit">افزایش موجودی</option><option value="debit">کاهش موجودی</option></Select>
      <Input label="مبلغ دقیق (ریال)" inputMode="numeric" required value={amount} onChange={e => { setAmount(e.target.value); changed() }} /><Input label="علت و توضیح اجباری" minLength={10} maxLength={500} required value={reason} onChange={e => { setReason(e.target.value); changed() }} /><Input label="شناسهٔ پیگیری / تیکت" minLength={3} maxLength={120} required value={reference} onChange={e => { setReference(e.target.value); changed() }} />
      {wallet && value > 0 ? <p>موجودی فعلی: {rial(wallet.balanceRial)} · برآورد پس از تعدیل: {rial(after)} · موجودی نهایی زیر قفل دیتابیس دوباره بررسی می‌شود.</p> : null}<Button type="submit" disabled={!wallet || !Number.isSafeInteger(value) || value <= 0 || after < 0}>بازبینی و تأیید تعدیل</Button>
    </form></Card> : null}<p role="status">{notice}</p><Card><h2>تاریخچه و درخواست‌های تأیید</h2>{history.error ? <p role="alert">{history.error}</p> : history.data?.items.map(item => <section className="system-record" key={item.id}><strong>{item.direction === 'credit' ? 'افزایش' : 'کاهش'} {rial(item.amountRial)} · {label(item.status)}</strong><p>{item.ownerName} · <bdi>{item.ownerEmail || item.userId}</bdi> · {item.walletName}</p><p>{item.reason} · پیگیری: {item.reference}</p><p dir="ltr">{item.id} · {item.walletId}</p><p>{date(item.createdAt)}{item.beforeRial !== null ? ` · ${rial(item.beforeRial)} ← ${rial(item.afterRial!)}` : ''}</p>
      {item.status === 'awaiting_approval' ? <Button variant="secondary" onClick={() => sensitive('wallet.approve', { id: item.id, confirm: true }, `تأیید مدیر دوم برای ${item.id}؛ ${rial(item.amountRial)}؛ کاربر ${item.ownerEmail || item.userId}؛ کیف پول ${item.walletName || ''} (${item.walletId})؛ ${item.reason}`, async proof => { await post(`/finance/adjustments/${item.id}/approve`, { confirm: true, proof }); history.refetch(); setNotice('تعدیل توسط مدیر دوم تأیید شد.') })}>تأیید توسط مدیر دوم</Button> : null}</section>)}<Pagination page={page} pages={history.data?.pages ?? 0} setPage={setPage} /></Card></div>
}

interface Backup { id: string; kind: string; status: string; stage: string; createdAt: string; actorId: string; size?: number; checksum?: string; message?: string; sourceId?: string; preBackupId?: string; snapshot?: { counts: Record<string, number>; pgMajor: number; schemaHead: string }; restored?: { counts: Record<string, number> } }
export function SystemBackups() {
  const capabilities = useOutletContext<Capabilities>()
  const query = useApiQuery(() => capabilities.backupsEnabled ? get<Backup[]>('/backups') : Promise.resolve([]), [capabilities.backupsEnabled]), sensitive = useSensitive()
  const [notice, setNotice] = useState(''), [file, setFile] = useState<File | null>(null), [detail, setDetail] = useState<Backup | null>(null), [phrase, setPhrase] = useState('')
  if (!capabilities.backupsEnabled) return <Card><h2>پشتیبان‌گیری نیاز به تنظیم میزبان دارد</h2><p>اپراتور باید کلید مستقل Backup، شناسهٔ سامانه، ابزارهای PostgreSQL و فضای خصوصی را آماده و SYSTEM_BACKUP_ENABLED را فعال کند. Restore کلید فعال‌سازی جداگانه دارد.</p></Card>
  return <div className="page-stack"><Card><h2>پشتیبان‌گیری خصوصی PostgreSQL</h2><p>فایل‌ها رمزگذاری‌شده و خارج از Web Root هستند. دانلود فقط با تأیید یک‌بارمصرف و کوتاه‌مدت ممکن است؛ کلیدهای خارجی باید جداگانه نگهداری شوند.</p>
    <div className="system-actions"><Button onClick={() => sensitive('backup.backup', { confirm: true }, 'ساخت Backup رمزگذاری‌شده از دیتابیس فعال؛ هیچ موجودی یا سفارشی تغییر نمی‌کند.', async proof => { const job = await post<Backup>('/backups', { confirm: true, proof }); setNotice(`عملیات ${job.id} ثبت شد.`); query.refetch() })}>ساخت Backup</Button><Button variant="secondary" onClick={query.refetch}>به‌روزرسانی وضعیت</Button></div>
    <label className="field"><span>بارگذاری Backup همین سامانه (.psb)</span><input type="file" accept=".psb" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
    <Button variant="secondary" disabled={!file} onClick={async () => { if (!file) return; try { const caps = await get<Capabilities>('/capabilities'); if (file.size > caps.maxUploadBytes) throw new Error('فایل بیش از سقف مجاز است.'); const bytes = await file.arrayBuffer(), checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join(''); sensitive('backup.upload', { checksum, size: bytes.byteLength, confirm: true }, `بارگذاری ${file.name} (${file.size} بایت)؛ فقط بررسی اصالت، بدون Restore.`, async proof => { await systemBinary(base + '/backups/upload', { method: 'POST', body: bytes, headers: { 'x-system-proof': proof } }); setFile(null); query.refetch() }) } catch (e) { setNotice(errorText(e)) } }}>بررسی و بارگذاری</Button>
    <p role="status">{notice}</p>{query.error ? <p role="alert">{query.error}</p> : query.loading ? <p role="status">در حال دریافت…</p> : query.data?.map(job => <section className="system-record" key={job.id}><strong>{label(job.kind)} · {label(job.status)}</strong><p>{date(job.createdAt)} · مرحله: {label(job.stage)} · {job.size ? `${job.size.toLocaleString('fa-IR')} بایت` : ''}</p><p className="system-monospace" dir="ltr">{job.id}<br />{job.checksum}</p>{job.message ? <p role="status">{job.message}</p> : null}<div className="system-actions"><Button variant="secondary" size="sm" onClick={() => { setDetail(job); setPhrase('') }}>جزئیات / بازیابی</Button>
      {['backup', 'upload'].includes(job.kind) && job.status === 'completed' ? <><Button variant="secondary" size="sm" onClick={() => sensitive('backup.download', { id: job.id, confirm: true }, `دانلود خصوصی Backup ${job.id}؛ فایل حاوی دادهٔ حساس است و رمزگذاری‌شده می‌ماند.`, async proof => { const response = await systemBinary(`${base}/backups/${job.id}/download`, { method: 'POST', body: JSON.stringify({ confirm: true, proof }), headers: { 'Content-Type': 'application/json' } }); download(await response.blob(), `parserver-${job.id}.psb`) })}>دانلود رمزگذاری‌شده</Button><Button variant="secondary" size="sm" onClick={() => sensitive('backup.rehearsal', { sourceId: job.id, confirm: true }, `بازیابی آزمایشی ${job.id} در دیتابیس موقت؛ بدون تغییر دیتابیس فعال.`, async proof => { await post(`/backups/${job.id}/rehearse`, { confirm: true, proof }); query.refetch() })}>آزمایش بازیابی</Button><Button variant="danger" size="sm" onClick={() => sensitive('backup.delete', { id: job.id, confirm: true }, `حذف فایل رمزگذاری‌شدهٔ ${job.id}؛ نسخه‌های موردنیاز Recovery قابل حذف نیستند.`, async proof => { await post(`/backups/${job.id}/delete`, { confirm: true, proof }); query.refetch() })}>حذف فایل</Button></> : null}
      {job.kind === 'restore' && job.status === 'awaiting_approval' ? <Button variant="danger" onClick={() => { setDetail(job); setPhrase('') }}>تأیید مدیر دوم</Button> : null}</div></section>)}
  </Card><Modal trapFocus open={!!detail} onClose={() => setDetail(null)} title="جزئیات و کنترل بازیابی"><div className="form-stack"><p><strong>{detail ? label(detail.kind) : ''} · {detail ? label(detail.status) : ''}</strong></p><dl className="system-facts"><dt>شناسهٔ عملیات</dt><dd dir="ltr">{detail?.id}</dd><dt>نسخهٔ PostgreSQL</dt><dd>{detail?.snapshot?.pgMajor || '—'}</dd><dt>نسخهٔ Schema</dt><dd>{detail?.snapshot?.schemaHead || '—'}</dd><dt>Checksum فایل</dt><dd dir="ltr">{detail?.checksum || '—'}</dd></dl>{detail?.restored && detail.snapshot ? <><h3>خلاصهٔ تغییرات پیش از بازیابی</h3><div className="system-counts">{Object.entries(detail.snapshot.counts).map(([name, before]) => <p key={name}><bdi>{countLabel[name] || name}</bdi>: فعلی {before.toLocaleString('fa-IR')} ← پس از بازیابی {(detail.restored?.counts[name] ?? 0).toLocaleString('fa-IR')}</p>)}</div></> : null}<details><summary>جزئیات فنی عملیات</summary><pre dir="ltr" className="system-json">{JSON.stringify(detail, null, 2)}</pre></details>
    {detail && (detail.kind === 'rehearsal' && detail.status === 'completed' || detail.kind === 'restore' && detail.status === 'awaiting_approval') ? <><p className="system-error">بازیابی داده‌های جدیدتر را از بین می‌برد و نشست‌ها را می‌بندد. فقط پس از تطبیق مالی، Backup سالم پیش از عملیات و تأیید مدیر دوم اجرا می‌شود. اگر دفتر مالی یا سفارش‌ها تغییر کرده باشند، بازیابی آنلاین مسدود خواهد شد.</p><Input label="برای ادامه عبارت RESTORE DATABASE را وارد کنید" value={phrase} onChange={e => setPhrase(e.target.value)} />
      <Button variant="danger" disabled={phrase !== 'RESTORE DATABASE' || !capabilities.restoreEnabled} onClick={() => { const approve = detail.kind === 'restore', payload = approve ? { id: detail.id, confirm: 'RESTORE DATABASE' } : { rehearsalId: detail.id, confirm: 'RESTORE DATABASE' }; setDetail(null); sensitive(approve ? 'backup.approve' : 'backup.restore', payload, `${approve ? 'تأیید نهایی توسط مدیر دوم' : 'درخواست'} بازیابی ${detail.id}؛ داده‌های جدیدتر حذف و نشست‌ها بسته می‌شوند.`, async proof => { await post(approve ? `/restores/${detail.id}/approve` : '/restores', { ...payload, id: undefined, proof }); setDetail(null); query.refetch() }) }}>{detail.kind === 'restore' ? 'بازبینی تأیید نهایی مدیر دوم' : 'درخواست بازیابی کنترل‌شده'}</Button></> : null}
  </div></Modal></div>
}
