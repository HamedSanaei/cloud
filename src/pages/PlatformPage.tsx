import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link2, RefreshCw, Server, WalletCards } from 'lucide-react'
import { apiGet, apiPost } from '../lib/apiClient'
import { Card, SectionHeading } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Input, Select } from '../components/ui/FormControls'
import { PageHeader } from '../components/ui/PageHeader'
import { Modal } from '../components/ui/Modal'

type Data<T> = { data: T }
interface Status { enabled: boolean; linked: boolean }
interface WalletData { balance: { balance_minor: number; currency: string; formatted: string }; history: { items: Array<{ entry_id: string; formatted: string; description: string; reference_label: string }> } }
interface Machine { server_id: string; display_name?: string; provider_key?: string; state: string; ip?: string; operating_system?: string }
interface Offer { id: string; name: string; provider: string; location: string; priceMinor: number; currency: string; formattedPrice: string; displayPriceMinor: number | null; billingModel: string; cpu: number; ramGb: number }
interface Notice { id: string; text: string; createdAt: string }
interface Pending { server: Machine; action: string; body: Record<string, unknown>; key: string }
const actionLabels: Record<string, string> = { 'power-on': 'روشن کردن', 'power-off': 'خاموش کردن', reboot: 'راه‌اندازی مجدد', reinstall: 'نصب مجدد سیستم‌عامل', 'reset-password': 'بازنشانی رمز', delete: 'حذف سرور', 'ssh-port': 'افزودن پورت SSH' }
const operationActions: Record<string, string> = { start: 'power-on', stop: 'power-off', reboot: 'reboot', reinstall: 'reinstall', password_reset: 'reset-password', delete: 'delete' }
const operationStatusLabels: Record<string, string> = { pending: 'در انتظار', running: 'در حال اجرا', success: 'موفق؛ تأیید ارائه‌دهنده', failed: 'ناموفق', outcome_unknown: 'نتیجه نامشخص؛ نیازمند بررسی', dispatch_completed: 'ارسال درخواست انجام شد؛ پایان عملیات تأیید نشده' }
interface Receipt { id: string; type: string; action?: string; status: string; detail?: string; observedState?: string; updatedAt: string }

const get = async <T,>(path: string) => (await apiGet<Data<T>>('/platform' + path, { timeoutMs: 50000 })).data
const post = async <T,>(path: string, body: unknown, key: string = crypto.randomUUID()) => (await apiPost<Data<T>>('/platform' + path, body, { headers: { 'idempotency-key': key }, timeoutMs: 50000 })).data

export function PlatformGate({ fallback }: { fallback: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [failure, setFailure] = useState('')
  useEffect(() => { void apiGet<Data<Status>>('/integration/status').then(r => setEnabled(r.data.enabled)).catch(() => setFailure('وضعیت پلتفرم دریافت نشد؛ صفحه را دوباره بارگذاری کنید.')) }, [])
  if (failure) return <p role="alert">{failure}</p>
  if (enabled === null) return <p role="status">در حال دریافت وضعیت اتصال…</p>
  return enabled ? <PlatformPage /> : fallback
}

export function PlatformPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [code, setCode] = useState('')
  const [wallet, setWallet] = useState<WalletData | null>(null)
  const [servers, setServers] = useState<Machine[]>([])
  const [offers, setOffers] = useState<Offer[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [gateway, setGateway] = useState('')
  const [gateways, setGateways] = useState<string[]>([])
  const [amount, setAmount] = useState('')
  const [payment, setPayment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [selected, setSelected] = useState<Machine | null>(null)
  const [operations, setOperations] = useState<string[]>([])
  const [images, setImages] = useState<Array<{ ref: string; name: string }>>([])
  const [image, setImage] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [purchaseOffer, setPurchaseOffer] = useState<Offer | null>(null)
  const [purchaseImages, setPurchaseImages] = useState<Array<{ id: string; name: string }>>([])
  const [purchaseImage, setPurchaseImage] = useState('')
  const [purchaseKey, setPurchaseKey] = useState(crypto.randomUUID())
  const [rechargeKey, setRechargeKey] = useState(crypto.randomUUID())
  const [account, setAccount] = useState<{ superadmin: boolean; testPortManagement: boolean } | null>(null)
  const [port, setPort] = useState('')
  const [history, setHistory] = useState<Receipt[]>([])
  const [secret, setSecret] = useState<{ serverId: string; claimId: string; username: string; password: string } | null>(null)
  const [adminUsers, setAdminUsers] = useState<Array<{ id: string; username: string }>>([])
  const [targetUser, setTargetUser] = useState('')
  const [adjustment, setAdjustment] = useState('')
  const [reason, setReason] = useState('')
  const [adjustKey, setAdjustKey] = useState(crypto.randomUUID())

  const refresh = useCallback(async () => {
    const state = (await apiGet<Data<Status>>('/integration/status')).data
    setStatus(state)
    if (!state.enabled || !state.linked) return
    setNotices(await get<Notice[]>('/notifications'))
    setAccount(await get('/account'))
    const [w, s, o] = await Promise.all([get<WalletData>('/wallet'), get<Machine[]>('/servers'), get<Offer[]>('/offers')])
    setWallet(w); setServers(s); setOffers(o)
  }, [])

  const perform = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : 'عملیات تکمیل نشد') } finally { setBusy(false) }
  }, [])

  useEffect(() => { void perform(refresh) }, [perform, refresh])
  useEffect(() => {
    if (!status?.linked) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() }
      catch { if (!stopped) setError('خواندن موجودی و وضعیت مشترک ممکن نشد؛ اطلاعات نمایش‌داده‌شده ممکن است قدیمی باشد.') }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 30000) }
    }
    timer = setTimeout(() => void poll(), 30000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh, status?.linked])
  useEffect(() => {
    const id = selected?.server_id
    if (!id || !status?.linked) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const [detail, records] = await Promise.all([
          get<{ server: Machine; operations: string[] }>(`/servers/${id}`),
          get<Receipt[]>(`/servers/${id}/operations`),
        ])
        if (!stopped) {
          setSelected(detail.server); setOperations(detail.operations); setHistory(records)
        }
      } catch {
        if (!stopped) setError('خواندن وضعیت جدید سرور ممکن نشد؛ عملیات را تکرار نکنید.')
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 15000)
      }
    }
    timer = setTimeout(() => void poll(), 15000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [selected?.server_id, status?.linked])

  const connect = () => perform(async () => {
    await apiPost('/integration/connect', { code: code.trim() })
    setCode(''); await refresh()
  })
  const manage = (server: Machine) => perform(async () => {
    const detail = await get<{ server: Machine; operations: string[] }>(`/servers/${server.server_id}`)
    setSelected(detail.server); setOperations(detail.operations); setImages([]); setImage(''); setResult(''); setSecret(null)
    setHistory(await get(`/servers/${server.server_id}/operations`))
  })
  const prepare = (action: string) => perform(async () => {
    if (!selected) return
    const key = crypto.randomUUID()
    const body: Record<string, unknown> = action === 'reinstall' ? { image } : action === 'ssh-port' ? { port: Number(port) } : {}
    if (['power-off', 'reinstall', 'reset-password', 'delete', 'ssh-port'].includes(action)) {
      const confirmation = await post<{ confirmationToken: string }>(`/servers/${selected.server_id}/confirmations/${action}`, body, key)
      body.confirmationToken = confirmation.confirmationToken
    }
    setPending({ server: selected, action, body, key })
  })
  const execute = () => perform(async () => {
    if (!pending) return
    const outcome = await post<{ accepted: boolean; replayed: boolean; outcome_unknown: boolean }>(`/servers/${pending.server.server_id}/actions/${pending.action}`, pending.body, pending.key)
    setResult(outcome.outcome_unknown ? 'نتیجه هنوز قطعی نیست؛ برای بررسی وضعیت سرور را تازه‌سازی کنید و عملیات را تکرار نکنید.' : outcome.replayed ? 'این درخواست قبلاً ثبت شده است.' : 'درخواست پذیرفته شد. وضعیت نهایی سرور پس از تأیید ارائه‌دهنده نمایش داده می‌شود.')
    setPending(null); await refresh()
    setHistory(await get(`/servers/${pending.server.server_id}/operations`))
  })
  const startRecharge = () => perform(async () => {
    const value = Number(amount)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('مبلغ صحیح و مثبت وارد کنید')
    const paymentResult = await post<{ paymentUrl: string }>('/recharge', { amountMinor: value, gateway }, rechargeKey)
    const url = new URL(paymentResult.paymentUrl)
    if (url.protocol !== 'https:') throw new Error('آدرس پرداخت امن نیست')
    setPayment(url.toString()); await refresh()
  })
  const chooseOffer = (offer: Offer) => perform(async () => {
    const list = await get<Array<{ id: string; name: string }>>(`/offers/${offer.id}/images`)
    setPurchaseOffer(offer); setPurchaseImages(list); setPurchaseImage(''); setPurchaseKey(crypto.randomUUID())
  })
  const buy = () => perform(async () => {
    if (!purchaseOffer) return
    const response = await post<{ serverId: string }>('/orders', { offerId: purchaseOffer.id, image: purchaseImage, expectedMinor: purchaseOffer.priceMinor, expectedCurrency: purchaseOffer.currency }, purchaseKey)
    setResult(`درخواست ساخت سرور ثبت شد: ${response.serverId}. نتیجه نهایی در این صفحه و ربات اعلام می‌شود.`)
    setPurchaseOffer(null); await refresh()
  })
  const claimPassword = () => perform(async () => {
    if (!selected) return
    const claimed = await post<{ claimId: string; username: string; password: string }>(`/servers/${selected.server_id}/credentials/claim`, {})
    setSecret({ ...claimed, serverId: selected.server_id })
  })
  const acknowledgePassword = () => perform(async () => {
    if (!secret) return
    await post(`/servers/${secret.serverId}/credentials/ack`, { claimId: secret.claimId })
    setSecret(null)
  })
  const adjustWallet = () => perform(async () => {
    const value = Number(adjustment)
    if (!Number.isSafeInteger(value) || value === 0) throw new Error('مبلغ اصلاح باید عدد صحیح و غیرصفر باشد')
    await post(`/admin/users/${targetUser}/wallet-adjustments`, { amountMinor: value, reason: reason.trim() }, adjustKey)
    setResult('اصلاح موجودی در دفترکل مشترک ثبت شد و برای کاربر اعلان ارسال می‌شود.')
    setAdjustment(''); setReason(''); setAdjustKey(crypto.randomUUID()); await refresh()
  })
  const sharedTest = selected?.ip === '217.20.121.89' && account?.superadmin

  return <div className="page-stack">
    <PageHeader title="پلتفرم مشترک سایت و تلگرام" subtitle="یک حساب، یک کیف پول و یک تعرفه برای هر دو سرویس" actions={<Button disabled={busy} icon={<RefreshCw size={17} />} onClick={() => void perform(refresh)}>تازه‌سازی</Button>} />
    {error && <div className="platform-error" role="alert">{error}</div>}
    {result && <div className="platform-result" role="status">{result}</div>}
    <Card>
      <SectionHeading title="اتصال حساب تلگرام" icon={<Link2 size={20} />} />
      {!status?.enabled ? <p>اتصال پلتفرم مشترک هنوز توسط مدیر فعال نشده است.</p> : <>
        <p>{status.linked ? 'حساب متصل است. برای جایگزینی کلید لغوشده، کد اتصال جدید وارد کنید.' : 'در چت خصوصی ربات دستور /website را ارسال کنید و کد یک‌بارمصرف را اینجا وارد کنید.'}</p>
        <div className="platform-inline"><Input aria-label="کد اتصال تلگرام" value={code} dir="ltr" placeholder="cpl_…" onChange={e => setCode(e.target.value)} /><Button disabled={busy || !code} onClick={() => void connect()}>اتصال امن</Button></div>
      </>}
    </Card>
    {status?.enabled && status.linked && <>
      <Card><SectionHeading title="کیف پول مشترک" icon={<WalletCards size={20} />} />
        <h2>{wallet?.balance.formatted ?? 'در حال دریافت…'}</h2>
        <Button disabled={busy} onClick={() => void perform(async () => { const list = await get<string[]>('/recharge/gateways'); setGateways(list); setGateway(list[0] ?? ''); setRechargeKey(crypto.randomUUID()) })}>شارژ کیف پول</Button>
        {gateways.length > 0 && <div className="platform-inline"><Input label={`مبلغ (${wallet?.balance.currency ?? ''})`} inputMode="numeric" value={amount} onChange={e => { setAmount(e.target.value); setRechargeKey(crypto.randomUUID()); setPayment('') }} /><Select label="درگاه پرداخت" value={gateway} onChange={e => { setGateway(e.target.value); setRechargeKey(crypto.randomUUID()); setPayment('') }}>{gateways.map(g => <option key={g}>{g}</option>)}</Select><Button disabled={busy || !amount} onClick={() => void startRecharge()}>دریافت لینک پرداخت</Button></div>}
        {payment && <a className="button button--primary button--md" href={payment} target="_blank" rel="noreferrer">ادامه پرداخت امن</a>}
        <div className="platform-history">{wallet?.history.items.map(item => <article key={item.entry_id}><span>{item.description || item.reference_label}</span><b dir="ltr">{item.formatted}</b></article>)}</div>
      </Card>
      <Card><SectionHeading title="سرورهای مشترک" icon={<Server size={20} />} />
        {account?.superadmin && <Button disabled={busy} onClick={() => void perform(async () => { await post('/admin/test-server/register', {}); setResult('سرور آزمایشی پس از تطبیق شناسه و IP ثبت شد؛ تغییری در خود سرور ایجاد نشد.'); await refresh() })}>شناسایی و اتصال leaseweb-test</Button>}
        <div className="platform-servers">{servers.map(server => <article key={server.server_id}><strong>{server.display_name || server.provider_key || server.server_id.slice(0, 8)}</strong><p dir="ltr">{server.ip}</p><p>{server.state} · {server.operating_system ?? 'سیستم‌عامل نامشخص'}</p><Button disabled={busy} onClick={() => void manage(server)}>مدیریت و مشاهده نتیجه</Button></article>)}</div>
        {selected && <section className="platform-manager"><h3>مدیریت {selected.display_name || selected.server_id.slice(0, 8)}</h3><div className="platform-inline">{operations.filter(op => operationActions[op] && op !== 'reinstall' && !(sharedTest && op === 'delete')).map(op => <Button key={op} disabled={busy} variant={op === 'delete' ? 'danger' : 'secondary'} onClick={() => void prepare(operationActions[op])}>{actionLabels[operationActions[op]]}</Button>)}{operations.includes('reinstall') && <Button disabled={busy} onClick={() => void perform(async () => { setImages(await get(`/servers/${selected.server_id}/images`)) })}>انتخاب سیستم‌عامل برای نصب مجدد</Button>}<Button disabled={busy || Boolean(secret)} onClick={() => void claimPassword()}>دریافت رمز یک‌بارمصرف</Button></div>
          {images.length > 0 && <div className="platform-inline"><Select label="سیستم‌عامل جدید" value={image} onChange={e => setImage(e.target.value)}><option value="">انتخاب کنید</option>{images.map(i => <option key={i.ref} value={i.ref}>{i.name}</option>)}</Select><Button disabled={busy || !image} onClick={() => void prepare('reinstall')}>آماده‌سازی نصب مجدد</Button></div>}
          {sharedTest && (account?.testPortManagement ? <div className="platform-inline"><Input label="پورت جدید SSH (۱۰۲۴ تا ۶۵۵۳۵)" type="number" min={1024} max={65535} value={port} onChange={e => setPort(e.target.value)} /><Button disabled={busy || !port} onClick={() => void prepare('ssh-port')}>تأیید افزودن پورت</Button></div> : <p className="muted-copy">مدیریت پورت نیازمند نصب ابزار امن داخل سرور و پیکربندی SSH توسط مدیر است.</p>)}
          {secret && <div className="platform-result"><p>رمز فقط در حافظه این صفحه است. پس از ذخیره در محل امن، دریافت را تأیید کنید.</p><p dir="ltr">{secret.username}: <code>{secret.password}</code></p><Button disabled={busy} onClick={() => void acknowledgePassword()}>ذخیره کردم؛ پاک کردن رمز</Button></div>}
          <h4>سابقه و نتیجه عملیات</h4><p className="muted-copy">«موفق» تنها پس از مشاهده نتیجه واقعی نمایش داده می‌شود. پذیرش درخواست با پایان عملیات یکسان نیست؛ وضعیت و مجوزها خودکار تازه می‌شوند.</p>
          <div className="platform-history">{history.map(item => <article key={item.id}><span>{item.action ? actionLabels[operationActions[item.action] ?? item.action] ?? item.action : item.type} · {operationStatusLabels[item.status] ?? item.status}{item.observedState ? ` · ${item.observedState}` : ''}{item.detail ? ` · ${item.detail}` : ''}</span><time>{new Date(item.updatedAt).toLocaleString('fa-IR')}</time></article>)}</div>
        </section>}
      </Card>
      <Card><SectionHeading title="خرید با تعرفه مشترک ربات" /><div className="platform-servers">{offers.map(offer => <article key={offer.id}><h3>{offer.name}</h3><p>{offer.provider} · {offer.location}</p><p>{offer.cpu} vCPU · {offer.ramGb} GB</p><strong>{offer.formattedPrice} / {offer.billingModel.includes('hourly') ? 'ساعت' : 'ماه'}</strong><Button disabled={busy || offer.displayPriceMinor == null} onClick={() => void chooseOffer(offer)}>انتخاب</Button></article>)}</div>
        {purchaseOffer && <section className="platform-manager"><h3>تأیید خرید {purchaseOffer.name}</h3><Select label="سیستم‌عامل" value={purchaseImage} onChange={e => setPurchaseImage(e.target.value)}><option value="">انتخاب کنید</option>{purchaseImages.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</Select><p>مبلغ تومانی برآورد نرخ فعلی تتر است. برداشت با نرخ معتبر لحظه ثبت سفارش محاسبه می‌شود؛ تغییر تعرفه ارائه‌دهنده نیازمند انتخاب دوباره پلن است.</p><Button disabled={busy || !purchaseImage} onClick={() => void buy()}>تأیید خرید با نرخ لحظه ثبت سفارش</Button></section>}
      </Card>
      {account?.superadmin && <Card><SectionHeading title="مدیریت موجودی مشترک کاربران" /><Button disabled={busy} onClick={() => void perform(async () => setAdminUsers(await get('/admin/users')))}>دریافت کاربران</Button><div className="platform-inline"><Select label="کاربر" value={targetUser} onChange={e => { setTargetUser(e.target.value); setAdjustKey(crypto.randomUUID()) }}><option value="">انتخاب کنید</option>{adminUsers.map(u => <option key={u.id} value={u.id}>{u.username || u.id}</option>)}</Select><Input label="اصلاح موجودی (تومان، منفی برای کسر)" inputMode="numeric" value={adjustment} onChange={e => { setAdjustment(e.target.value); setAdjustKey(crypto.randomUUID()) }} /><Input label="دلیل اصلاح" value={reason} onChange={e => { setReason(e.target.value); setAdjustKey(crypto.randomUUID()) }} /><Button disabled={busy || !targetUser || !adjustment || reason.trim().length < 4} onClick={() => void adjustWallet()}>ثبت اصلاح حسابرسی‌شده</Button></div></Card>}
      <Card><SectionHeading title="نتیجه عملیات و اعلان‌ها" /><div className="platform-history">{notices.map(n => <article key={n.id}><p style={{ whiteSpace: 'pre-line' }}>{n.text}</p><time>{new Date(n.createdAt).toLocaleString('fa-IR')}</time></article>)}</div></Card>
    </>}
    <Modal open={Boolean(pending)} title="تأیید عملیات سرور" onClose={() => { if (!busy) setPending(null) }}>
      <p>آیا {pending ? actionLabels[pending.action] : ''} روی سرور انتخابی اجرا شود؟ نصب مجدد و حذف سرور اطلاعات را پاک می‌کنند.</p>
      <p dir="ltr">{pending?.server.ip} {pending?.body.image ? String(pending.body.image) : ''} {pending?.body.port ? `SSH: ${String(pending.body.port)} (پورت قبلی حفظ می‌شود)` : ''}</p>
      <Button disabled={busy} onClick={() => void execute()}>تأیید اجرای عملیات</Button>
    </Modal>
  </div>
}
