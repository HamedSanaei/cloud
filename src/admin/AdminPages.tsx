import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ClipboardList, HardDrive, Search, Users } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatCount, formatFaDateTime, formatFaNumber, formatToman } from '../lib/format'
import { useAuth } from '../auth/AuthContext'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/FormControls'
import { Modal } from '../components/ui/Modal'
import { adminApi, userName, type AdminUser, type ListFilters, type Paged } from './api'
import { HetznerInventoryPanel } from './HetznerInventoryPanel'
import { LegacyPowerReview } from './LegacyPowerReview'
import { WalletLedgerAmountCells, WalletLedgerDescription } from '../components/ui/WalletLedgerCells'
import { emptyAmount, movementAmounts, movementHeaders, transactionStatus } from '../lib/walletHistory'

const dateLabel = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('fa-IR')
}
const timeLabel = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('fa-IR')
}
const orderLabels: Record<string, string> = {
  draft: 'پیش‌نویس', quoted: 'پیش‌فاکتور', awaiting_payment: 'در انتظار پرداخت',
  paid: 'پرداخت‌شده', queued: 'در صف', provisioning: 'در حال ساخت',
  active: 'تحویل‌شده', failed: 'ناموفق', cancelled: 'لغوشده',
  requires_review: 'نیازمند بررسی', refunded: 'بازپرداخت‌شده',
}
const serverLabels: Record<string, string> = {
  active: 'فعال', provisioning: 'در حال ساخت', suspended: 'خاموش / تعلیق',
  terminated: 'حذف‌شده', failed: 'خطا',
}
const userLabels: Record<string, string> = { active: 'فعال', pending: 'در انتظار', disabled: 'غیرفعال' }
function statusTone(status: string) {
  if (['active', 'paid', 'queued'].includes(status)) return 'success'
  if (['provisioning', 'pending', 'awaiting_payment', 'requires_review', 'draft'].includes(status)) return 'warning'
  if (['failed', 'disabled', 'cancelled', 'terminated'].includes(status)) return 'danger'
  return 'neutral'
}
function Status({ status, kind }: { status: string; kind: 'order' | 'server' | 'user' }) {
  const labels = kind === 'order' ? orderLabels : kind === 'server' ? serverLabels : userLabels
  return <span className={`admin-status admin-status--${statusTone(status)}`}>{labels[status] ?? status}</span>
}
function Heading({ title, subtitle, actions }: { title: string; subtitle: string; actions?: React.ReactNode }) {
  return <header className="admin-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{actions ? <div className="admin-heading__actions">{actions}</div> : null}</header>
}
function Panel({ title, subtitle, children, action }: { title?: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="admin-panel">
    {title ? <header className="admin-panel__heading"><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>{action}</header> : null}
    {children}
  </section>
}
function State({ loading, error, empty, retry, children }: { loading: boolean; error: string | null; empty: boolean; retry: () => void; children: React.ReactNode }) {
  if (loading) return <div className="admin-state" role="status"><span className="admin-spinner" /> در حال دریافت اطلاعات…</div>
  if (error) return <div className="admin-state admin-state--error" role="alert"><span>{error}</span><button type="button" onClick={retry}>تلاش دوباره</button></div>
  if (empty) return <div className="admin-state">موردی برای نمایش یافت نشد.</div>
  return <>{children}</>
}
function ReturnLink({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link className="admin-secondary-link" to={to}><ArrowRight size={17} />{children}</Link>
}
function SearchBar({ value, onChange, status, onStatus, options, placeholder }: {
  value: string; onChange: (value: string) => void
  status: string; onStatus: (value: string) => void
  options: Array<{ value: string; label: string }>; placeholder: string
}) {
  return <div className="admin-filters">
    <label className="admin-search"><Search size={18} /><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label="جست‌وجو" /></label>
    <select aria-label="فیلتر وضعیت" value={status} onChange={e => onStatus(e.target.value)}>
      <option value="">همه وضعیت‌ها</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </div>
}
function Pager({ data, onPage }: { data: Paged<unknown>; onPage: (page: number) => void }) {
  if (data.total <= data.limit) return <p className="admin-pager__summary">{formatCount(data.total)} مورد</p>
  return <div className="admin-pager">
    <span>صفحه {formatCount(data.page)} از {formatCount(data.pages)} · {formatCount(data.total)} مورد</span>
    <div><button type="button" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>قبلی</button>
      <button type="button" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>بعدی</button></div>
  </div>
}
function useFilters() {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(search), 260); return () => window.clearTimeout(timer) }, [search])
  return { search, setSearch: (s: string) => { setSearch(s); setPage(1) },
    debounced, status, setStatus: (s: string) => { setStatus(s); setPage(1) }, page, setPage }
}
function adminTableWrap(table: React.ReactNode) {
  return <div className="admin-table-scroll">{table}</div>
}

export function AdminOverview() {
  const info = useApiQuery(adminApi.overview)
  const { user } = useAuth()
  const data = info.data
  const customers = data?.accounts.filter(account => account.role === 'user') ?? []
  const managers = data?.accounts.filter(account => account.role !== 'user') ?? []
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0)
  const breakdown = (counts: Record<string, number>, labels: Record<string, string>, states: string[]) =>
    states.map(status => `${labels[status]} ${formatCount(counts[status] ?? 0)}`).join(' · ')
  const finance = data?.finance
  return <div className="admin-page">
    <Heading title="نمای کلی" subtitle="وضعیت حساب‌ها، خریدها و سرویس‌ها"
      actions={<Button variant="secondary" disabled={info.loading} onClick={info.refetch}>به‌روزرسانی</Button>} />
    <State loading={info.loading} error={info.error} empty={false} retry={info.refetch}>
      {data ? <>
        <p className="admin-muted">آخرین به‌روزرسانی <time dateTime={data.checkedAt}>{formatFaDateTime(data.checkedAt, user?.timezone)}</time> · کل سوابق سایت</p>
        <div className="admin-metrics">
          <div className="admin-metric"><span>مشتریان</span><strong>{formatCount(customers.reduce((sum, row) => sum + row.count, 0))}</strong>
            <small>{breakdown(Object.fromEntries(customers.map(row => [row.status, row.count])), userLabels, ['active', 'pending', 'disabled'])}</small>
            <small>مدیران · {breakdown(managers.reduce<Record<string, number>>((counts, row) => {
              counts[row.status] = (counts[row.status] ?? 0) + row.count
              return counts
            }, {}), userLabels, ['active', 'pending', 'disabled'])}</small></div>
          <div className="admin-metric"><span>کل تاریخی سفارش‌ها</span><strong>{formatCount(total(data.orderCounts))}</strong>
            <small>{breakdown(data.orderCounts, orderLabels, ['awaiting_payment', 'paid', 'queued', 'provisioning', 'requires_review'])}</small>
            <small>{breakdown(data.orderCounts, orderLabels, ['active', 'failed', 'cancelled', 'refunded', 'draft', 'quoted'])}</small></div>
          <div className="admin-metric"><span>سرورهای فعال</span><strong>{formatCount(data.serverCounts.active ?? 0)}</strong>
            <small>از {formatCount(total(data.serverCounts))} سرور ثبت‌شده در کل تاریخ</small>
            <small>{breakdown(data.serverCounts, serverLabels, ['provisioning', 'suspended', 'terminated', 'failed'])}</small></div>
          <div className="admin-metric"><span>سفارش‌های در جریان و نیازمند پیگیری عملیاتی</span><strong>{formatCount(data.ordersNeedingAttention)}</strong>
            <small>منتظر پرداخت، پرداخت‌شده، در صف، در حال ساخت یا نیازمند بررسی</small>
            <small>{formatCount(data.overdue)} اشتراک معوق · {formatCount(data.failedRenewals24h)} تلاش ناموفق تمدید در ۲۴ ساعت اخیر</small></div>
        </div>
        {finance && <>
          <Panel title="مبالغ ثبت‌شده در دفتر کیف پول" subtitle="همهٔ زمان‌ها، به تومان. خرید اولیه از سفارش‌های پرداخت‌شده، در صف، در حال ساخت یا تحویل‌شده محاسبه می‌شود.">
            <dl className="admin-fields">
              <Field label="خرید اولیهٔ پذیرفته‌شده، ناخالص" value={formatToman(finance.initialRial / 10)} />
              <Field label="تمدیدهای پرداخت‌شده، ناخالص" value={formatToman(finance.renewalRial / 10)} />
              <Field label="هزینهٔ ترافیک مازاد" value={formatToman((finance.trafficRial ?? 0) / 10)} />
              <Field label="بازپرداخت خدمات" value={formatToman(finance.refundsRial / 10)} />
              <Field label="خالص برداشت خدمات" value={formatToman(finance.netRial / 10)} />
              <Field label="شارژ کیف پول (جدا از فروش)" value={formatToman(finance.depositsRial / 10)} />
            </dl>
            <p className="admin-muted">خالص برابر برداشت خرید، تمدید و ترافیک مازاد، از جمله مبالغی که هنوز باید تطبیق داده شوند، منهای بازپرداخت خدمات است. مبالغ فاکتور برای تطبیق بررسی می‌شوند.</p>
          </Panel>
          <Panel title="موارد نیازمند بررسی مالی" subtitle={`${formatCount(finance.exceptionCount)} سفارش دارای اختلاف · ${formatCount(finance.renewalMismatchCount)} فاکتور تمدید با مغایرت دفترکل`}>
            {finance.exceptions.length ? adminTableWrap(<table className="admin-table"><thead><tr><th>سفارش</th><th>علت</th><th>فاکتور پرداخت‌شده</th><th>برداشت</th><th>بازپرداخت مرتبط</th></tr></thead>
              <tbody>{finance.exceptions.map(row => <tr key={row.id}>
                <td><Link to={`/admin/orders/${row.id}`}>{row.orderNumber}</Link></td>
                <td>{row.unreturned ? 'سفارش ناموفق با برداشت بازنگشته' : 'مغایرت فاکتور و دفترکل'}</td>
                <td>{formatToman(row.invoicedRial / 10)}</td><td>{formatToman(row.debitRial / 10)}</td><td>{formatToman(row.refundRial / 10)}</td>
              </tr>)}</tbody></table>) : <p>سفارشی برای تطبیق یافت نشد.</p>}
            {finance.exceptionCount > finance.exceptions.length && <p>۲۰ مورد با اولویت برداشت‌های بازنگشته نمایش داده شده‌اند.</p>}
          </Panel>
        </>}
        <div className="admin-overview-grid">
          <Panel title="آخرین سفارش‌ها" subtitle="پیگیری وضعیت سفارش‌های ثبت‌شده" action={<Link className="admin-text-link" to="/admin/orders">مشاهده همه</Link>}>
            <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>شماره سفارش</th><th>کاربر</th><th>مبلغ</th><th>وضعیت سفارش</th><th>وضعیت سرور مرتبط</th></tr></thead>
              <tbody>{data.recentOrders.map(o => <tr key={o.id}>
                <td><Link to={`/admin/orders/${o.id}`}>{o.orderNumber}</Link></td><td>{o.userName}</td>
                <td>{formatToman(o.totalToman)}</td><td><Status status={o.status} kind="order" /></td>
                <td>{o.serverStatus ? <Status status={o.serverStatus} kind="server" /> : '—'}</td>
              </tr>)}</tbody></table></div>
            {!data.recentOrders.length ? <div className="admin-state">هنوز سفارشی ثبت نشده است.</div> : null}
          </Panel>
          <Panel title="دسترسی سریع" subtitle="کارهای روزمره مدیریت">
            <div className="admin-shortcuts">
              <Link to="/admin/orders"><ClipboardList size={19} /><span><strong>مشاهده سفارش‌ها</strong><small>تاریخچه و وضعیت خریدها</small></span><ArrowLeft size={17} /></Link>
              <Link to="/admin/users"><Users size={19} /><span><strong>جست‌وجوی کاربران</strong><small>پروفایل، کیف پول و تراکنش‌ها</small></span><ArrowLeft size={17} /></Link>
              <Link to="/admin/servers"><HardDrive size={19} /><span><strong>مشاهده سرورها</strong><small>مشخصات و وضعیت سرویس‌ها</small></span><ArrowLeft size={17} /></Link>
            </div>
          </Panel>
        </div>
      </> : null}
    </State>
  </div>
}

export function AdminOrders() {
  const f = useFilters()
  const request: ListFilters = { page: f.page, search: f.debounced, status: f.status }
  const query = useApiQuery(() => adminApi.orders(request), [f.page, f.debounced, f.status])
  return <div className="admin-page">
    <Heading title="سفارش‌ها" subtitle="مشاهده، جست‌وجو و پیگیری سفارش‌های ثبت‌شده کاربران" />
    <SearchBar value={f.search} onChange={f.setSearch} status={f.status} onStatus={f.setStatus}
      placeholder="جست‌وجوی شماره سفارش یا نام سرور…"
      options={Object.entries(orderLabels).map(([value, label]) => ({ value, label }))} />
    <Panel title="فهرست سفارش‌ها" subtitle="برای مشاهده جزئیات روی شماره سفارش کلیک کنید.">
      <State loading={query.loading} error={query.error} empty={!query.data?.items.length} retry={query.refetch}>
        {query.data ? <>
          {adminTableWrap(<table className="admin-table"><thead><tr><th>شماره سفارش</th><th>کاربر</th><th>سرویس / نام سرور</th><th>مبلغ</th><th>وضعیت</th><th>تاریخ</th></tr></thead>
            <tbody>{query.data.items.map(o => <tr key={o.id}>
              <td><Link to={`/admin/orders/${o.id}`}>{o.orderNumber}</Link></td>
              <td><Link to={`/admin/users/${o.userId}`}>{o.userName}</Link></td><td>{o.hostname}</td>
              <td>{formatToman(o.totalToman)}</td><td><Status status={o.status} kind="order" /></td><td>{dateLabel(o.createdAt)}</td>
            </tr>)}</tbody></table>)}
          <div className="admin-mobile-cards">{query.data.items.map(o => <Link key={o.id} className="admin-mobile-record" to={`/admin/orders/${o.id}`}>
            <div><strong>{o.orderNumber}</strong><Status status={o.status} kind="order" /></div><span>{o.userName}</span><span>{formatToman(o.totalToman)}</span>
          </Link>)}</div>
          <Pager data={query.data} onPage={f.setPage} />
        </> : null}
      </State>
    </Panel>
  </div>
}

export function AdminUsers() {
  const f = useFilters()
  const request: ListFilters = { page: f.page, search: f.debounced, status: f.status }
  const query = useApiQuery(() => adminApi.users(request), [f.page, f.debounced, f.status])
  return <div className="admin-page">
    <Heading title="کاربران" subtitle="اطلاعات هویتی، وضعیت حساب و موجودی کاربران" />
    <SearchBar value={f.search} onChange={f.setSearch} status={f.status} onStatus={f.setStatus}
      placeholder="جست‌وجو با نام، ایمیل یا شماره موبایل…" options={Object.entries(userLabels).map(([value, label]) => ({ value, label }))} />
    <Panel title="فهرست کاربران" subtitle="روی نام کاربر کلیک کنید تا کیف پول، تراکنش‌ها و سرورهای او را ببینید.">
      <State loading={query.loading} error={query.error} empty={!query.data?.items.length} retry={query.refetch}>
        {query.data ? <>
          {adminTableWrap(<table className="admin-table"><thead><tr><th>نام کاربر</th><th>ایمیل</th><th>موبایل</th><th>موجودی</th><th>وضعیت</th></tr></thead>
            <tbody>{query.data.items.map(u => <tr key={u.id}>
              <td><Link to={`/admin/users/${u.id}`}>{userName(u)}</Link></td>
              <td dir="ltr">{u.email}</td><td dir="ltr">{u.mobile ?? '—'}</td>
              <td>{formatToman(u.balanceToman ?? 0)}</td><td><Status status={u.status} kind="user" /></td>
            </tr>)}</tbody></table>)}
          <div className="admin-mobile-cards">{query.data.items.map(u => <Link key={u.id} className="admin-mobile-record" to={`/admin/users/${u.id}`}>
            <div><strong>{userName(u)}</strong><Status status={u.status} kind="user" /></div>
            <span dir="ltr">{u.email}</span><span>موجودی: {formatToman(u.balanceToman ?? 0)}</span>
          </Link>)}</div>
          <Pager data={query.data} onPage={f.setPage} />
        </> : null}
      </State>
    </Panel>
  </div>
}

export function AdminServers() {
  const f = useFilters()
  const request: ListFilters = { page: f.page, search: f.debounced, status: f.status }
  const query = useApiQuery(() => adminApi.servers(request), [f.page, f.debounced, f.status])
  return <div className="admin-page">
    <Heading title="سرورها" subtitle="وضعیت سرویس‌ها و مشخصات فنی سرورهای کاربران" />
    <SearchBar value={f.search} onChange={f.setSearch} status={f.status} onStatus={f.setStatus}
      placeholder="جست‌وجو با نام سرور، IP یا ارائه‌دهنده…" options={Object.entries(serverLabels).map(([value, label]) => ({ value, label }))} />
    <Panel title="فهرست سرورها" subtitle="این بخش برای مشاهده مشخصات و وضعیت است.">
      <State loading={query.loading} error={query.error} empty={!query.data?.items.length} retry={query.refetch}>
        {query.data ? <>
          {adminTableWrap(<table className="admin-table"><thead><tr><th>نام سرور</th><th>مالک</th><th>IPv4</th><th>مشخصات</th><th>وضعیت</th><th>ارائه‌دهنده</th></tr></thead>
            <tbody>{query.data.items.map(s => <tr key={s.id}>
              <td><Link to={`/admin/servers/${s.id}`}>{s.name}</Link></td>
              <td><Link to={`/admin/users/${s.userId}`}>{s.ownerName}</Link></td><td dir="ltr">{s.ipv4 ?? '—'}</td>
              <td dir="ltr">{s.vcpu} vCPU · {formatFaNumber(s.memoryMb / 1024)} GB</td><td><Status status={s.status} kind="server" /></td><td dir="ltr">{s.provider}</td>
            </tr>)}</tbody></table>)}
          <div className="admin-mobile-cards">{query.data.items.map(s => <Link key={s.id} className="admin-mobile-record" to={`/admin/servers/${s.id}`}>
            <div><strong>{s.name}</strong><Status status={s.status} kind="server" /></div>
            <span>{s.ownerName}</span><span dir="ltr">{s.ipv4 ?? '—'} · {s.vcpu} vCPU · {formatFaNumber(s.memoryMb / 1024)} GB</span>
          </Link>)}</div>
          <Pager data={query.data} onPage={f.setPage} />
        </> : null}
      </State>
    </Panel>
    <HetznerInventoryPanel />
  </div>
}

function Field({ label, value, ltr }: { label: string; value: React.ReactNode; ltr?: boolean }) {
  return <div className="admin-field"><dt>{label}</dt><dd dir={ltr ? 'ltr' : undefined}>{value ?? '—'}</dd></div>
}
function Customer({ user }: { user: AdminUser | null }) {
  if (!user) return <p>اطلاعات کاربر یافت نشد.</p>
  return <><Field label="نام کاربر" value={userName(user)} /><Field label="ایمیل" value={user.email} ltr />
    <Link className="admin-secondary-link" to={`/admin/users/${user.id}`}>مشاهده پروفایل کاربر <ArrowLeft size={16} /></Link></>
}

export function AdminUserPage() {
  const { id = '' } = useParams()
  const result = useApiQuery(() => adminApi.user(id), [id])
  const info = result.data
  const [action, setAction] = useState<'block' | 'delete_data' | null>(null)
  const [reason, setReason] = useState('')
  const [confirmId, setConfirmId] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionResult, setActionResult] = useState('')
  const [busy, setBusy] = useState(false)
  function openAction(next: NonNullable<typeof action>) {
    setReason(''); setConfirmId(''); setActionError(''); setActionResult(''); setAction(next)
  }
  async function confirmAction() {
    if (busy || !action || confirmId.trim() !== id || reason.trim().length < 4) return
    setBusy(true); setActionError('')
    try {
      await adminApi.userAccountAction(id, action, reason.trim())
      setActionResult(action === 'block' ? 'حساب مسدود شد و نشست‌های آن پایان یافتند.' : 'داده‌های قابل حذف پاک شدند و حساب بسته شد.')
      setAction(null); result.refetch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'عملیات تکمیل نشد.')
    } finally { setBusy(false) }
  }
  const walletNames = new Map(info?.wallets.map(wallet => [wallet.id, wallet.name]))
  return <div className="admin-page">
    <Heading title="پروفایل کاربر" subtitle="مشاهده اطلاعات حساب، کیف پول و سرورهای متعلق به کاربر"
      actions={<ReturnLink to="/admin/users">بازگشت به کاربران</ReturnLink>} />
    {actionResult && <p role="status">{actionResult}</p>}
    <State loading={result.loading} error={result.error} empty={!info} retry={result.refetch}>
      {info ? <div className="admin-detail-grid">
        <div className="admin-detail-content">
          <Panel title="کیف پول">
            <div className="admin-wallet-total"><span>موجودی</span><strong>{formatToman(info.balanceToman)}</strong></div>
          </Panel>
          <Panel title="تراکنش‌های اخیر">
            {info.transactions.length ? adminTableWrap(<table className="admin-table admin-ledger"><thead><tr><th scope="col">شرح</th><th scope="col">کیف پول</th>
              {movementHeaders.map(header => <th scope="col" key={header}>{header}</th>)}<th scope="col">تاریخ</th><th scope="col">وضعیت</th></tr></thead>
              <tbody>{info.transactions.map(tx => <tr key={tx.id}>
                <td><WalletLedgerDescription admin transaction={{ ...tx, description: tx.description ?? '' }} /></td>
                <td>{tx.wallet ?? walletNames.get(tx.walletId) ?? emptyAmount}</td>
                <WalletLedgerAmountCells amounts={movementAmounts({ ...tx, amount: tx.amountToman, status: tx.status ?? 'success' })} />
                <td><time dateTime={tx.createdAt}>{timeLabel(tx.createdAt)}</time></td><td>{transactionStatus(tx.status ?? 'success')}</td>
              </tr>)}</tbody></table>) : <p className="admin-muted">تراکنشی ثبت نشده است.</p>}
          </Panel>
          <Panel title="سرورهای کاربر" action={<Link className="admin-text-link" to={`/admin/users/${id}/servers`}>مشاهده همه</Link>}>
            {info.servers.length ? <div className="admin-server-mini">{info.servers.slice(0, 4).map(s => <Link key={s.id} to={`/admin/servers/${s.id}`}>
              <span><HardDrive size={17} />{s.name}</span><Status status={s.status} kind="server" /></Link>)}</div> : <p className="admin-muted">سروری برای این کاربر ثبت نشده است.</p>}
          </Panel>
        </div>
        <div className="admin-detail-side">
          <Panel>
            <div className="admin-profile-avatar"><Users size={29} /></div><h2 className="admin-profile-name">{userName(info.user)}</h2>
            <div className="admin-profile-status"><Status status={info.user.status} kind="user" />{info.user.dataDeleted && ' · داده‌های حساب حذف شده‌اند'}</div>
            <dl className="admin-fields">
              <Field label="ایمیل" value={info.user.email} ltr />
              <Field label="شماره همراه" value={info.user.mobile || 'ثبت نشده'} ltr />
              <Field label="زمان عضویت" value={dateLabel(info.user.createdAt)} />
              <Field label="تأیید ایمیل" value={info.user.emailVerifiedAt ? 'تأیید شده' : 'تأیید نشده'} />
              <Field label="تأیید موبایل" value={info.user.mobileVerifiedAt ? 'تأیید شده' : 'تأیید نشده'} />
            </dl>
          </Panel>
          {info.actions && <Panel title="مدیریت حساب">
            <div className="form-stack">
              <Button variant="secondary" disabled={!info.actions.canBlock} onClick={() => openAction('block')}>مسدودسازی حساب</Button>
              <Button variant="danger" disabled={!!info.actions.deleteBlocked} onClick={() => openAction('delete_data')}>حذف داده‌های قابل حذف</Button>
              {info.actions.deleteBlocked && <p>{info.actions.deleteBlocked}</p>}
            </div>
          </Panel>}
        </div>
      </div> : null}
    </State>
    <Modal open={!!action && info?.user.id === id} title={action === 'block' ? 'مسدودسازی حساب' : 'حذف داده‌های قابل حذف'} trapFocus onClose={() => { if (!busy) setAction(null) }}>
      {action && info && <div className="form-stack">
        <p>حساب هدف <bdi>{userName(info.user)}</bdi> · <bdi>{id}</bdi></p>
        {action === 'block'
          ? <p>ورود و نشست‌های حساب متوقف می‌شوند. داده‌ها و سرویس‌ها باقی می‌مانند و چرخهٔ صورتحساب ادامه دارد.</p>
          : <><p>مشخصات شخصی و حقوقی، راه‌های ورود، نشست‌ها، اعلان‌ها، پیوندهای ورود و رمزهای موقت سرور پاک می‌شوند. حساب بسته می‌شود.</p>
            <p>سوابق سفارش، صورتحساب، دفترکل، سرور و پشتیبانی برای نگه‌داری باقی می‌مانند. حساب دارای سرویس فعال یا پرداخت باز باید ابتدا تعیین تکلیف شود.</p></>}
        <Input label="شناسهٔ حساب هدف را وارد کنید" dir="ltr" autoComplete="off" value={confirmId} onChange={event => setConfirmId(event.target.value)} />
        <Input label="دلیل عملیات" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />
        {actionError && <p role="alert">{actionError}</p>}
        <Button variant="danger" disabled={busy || confirmId.trim() !== id || reason.trim().length < 4} onClick={() => void confirmAction()}>
          {busy ? 'در حال ثبت…' : 'تأیید نهایی'}
        </Button>
      </div>}
    </Modal>
  </div>
}

export function AdminUserServers() {
  const { id = '' } = useParams()
  const f = useFilters()
  const filter = { page: f.page, search: f.debounced, status: '' }
  const result = useApiQuery(() => adminApi.userServers(id, filter), [id, f.page, f.debounced])
  return <div className="admin-page">
    <Heading title="سرورهای کاربر" subtitle="فهرست کامل سرویس‌های مربوط به این حساب، از دیتابیس سایت"
      actions={<ReturnLink to={`/admin/users/${id}`}>بازگشت به پروفایل</ReturnLink>} />
    <div className="admin-filters"><label className="admin-search"><Search size={18}/><input aria-label="جست‌وجوی سرور کاربر" value={f.search} onChange={e => f.setSearch(e.target.value)} placeholder="جست‌وجوی سرور یا IP…"/></label></div>
    <Panel title="سرورهای این حساب">
      <State loading={result.loading} error={result.error} empty={!result.data?.items.length} retry={result.refetch}>
        {result.data ? <>{adminTableWrap(<table className="admin-table"><thead><tr><th>نام سرور</th><th>IP</th><th>سخت‌افزار</th><th>ارائه‌دهنده</th><th>وضعیت</th></tr></thead>
          <tbody>{result.data.items.map(s => <tr key={s.id}>
            <td><Link to={`/admin/servers/${s.id}`}>{s.name}</Link></td><td dir="ltr">{s.ipv4 ?? '—'}</td>
            <td dir="ltr">{s.vcpu} vCPU · {s.memoryMb / 1024} GB · {s.diskGb} GB</td>
            <td>{s.provider}</td><td><Status status={s.status} kind="server" /></td></tr>)}</tbody></table>)}
          <div className="admin-mobile-cards">{result.data.items.map(s => <Link key={s.id} className="admin-mobile-record" to={`/admin/servers/${s.id}`}><div><strong>{s.name}</strong><Status kind="server" status={s.status} /></div><span dir="ltr">{s.ipv4 ?? '—'}</span></Link>)}</div>
          <Pager data={result.data} onPage={f.setPage} /></> : null}
      </State>
    </Panel>
  </div>
}

export function AdminOrderPage() {
  const { id = '' } = useParams()
  const result = useApiQuery(() => adminApi.order(id), [id])
  const info = result.data
  return <div className="admin-page">
    <Heading title="جزئیات سفارش" subtitle="اطلاعات سفارش، صاحب حساب و تاریخچه تغییر وضعیت"
      actions={<ReturnLink to="/admin/orders">بازگشت به سفارش‌ها</ReturnLink>} />
    <State loading={result.loading} error={result.error} empty={!info} retry={result.refetch}>
      {info ? <div className="admin-detail-grid">
        <div className="admin-detail-content">
          <Panel title={`سفارش ${info.order.orderNumber}`} action={<Status kind="order" status={info.order.status} />}>
            <dl className="admin-info-grid">
              <Field label="نام سرور" value={info.order.hostname} ltr />
              <Field label="مبلغ" value={formatToman(info.order.totalToman)} />
              <Field label="ارائه‌دهنده" value={info.order.provider} ltr />
              <Field label="موقعیت" value={info.order.providerLocation} ltr />
              <Field label="سیستم عامل" value={info.order.operatingSystem} ltr />
              <Field label="زمان ثبت" value={timeLabel(info.order.createdAt)} />
            </dl>
            {info.order.error ? <div className="admin-error-box" role="status">{info.order.error}</div> : null}
          </Panel>
          <Panel title="آیتم‌های سفارش">
            {info.items.map(item => <div key={item.id} className="admin-summary-line"><span>{item.description}</span><strong>{formatToman(item.totalToman)}</strong></div>)}
            {!info.items.length && <p className="admin-muted">آیتمی ثبت نشده است.</p>}
          </Panel>
          <Panel title="روند سفارش">
            {info.events.length ? <ol className="admin-timeline">{info.events.map((e, i) => <li key={`${e.createdAt}-${i}`}>
              <strong>{orderLabels[e.toStatus] ?? e.toStatus}</strong><time>{timeLabel(e.createdAt)}</time>{e.reason ? <p>{e.reason}</p> : null}
            </li>)}</ol> : <p className="admin-muted">تاریخچه‌ای ثبت نشده است.</p>}
          </Panel>
          {info.financialEvidence && <Panel title="مستندات تطبیق مالی" subtitle="شناسه‌ها و مبالغ ثبت‌شده برای بررسی این سفارش">
            <dl className="admin-fields">
              <Field label="فاکتور پرداخت‌شده" value={formatToman(info.financialEvidence.invoicedRial / 10)} />
              <Field label="برداشت خرید" value={formatToman(info.financialEvidence.debitRial / 10)} />
              <Field label="بازپرداخت مرتبط" value={formatToman(info.financialEvidence.refundRial / 10)} />
              <Field label="شناسهٔ فاکتورها" value={info.financialEvidence.invoiceIds.join(' · ') || '—'} ltr />
              <Field label="شناسهٔ تراکنش‌های مرتبط" value={info.financialEvidence.transactionIds.join(' · ') || '—'} ltr />
              <Field label="عملیات ارائه‌دهنده" value={info.financialEvidence.operations.map(op => <div key={op.id}><bdi>{op.id}</bdi> · <bdi>{op.kind} / {op.status}</bdi></div>)} />
              <Field label="۲۰ تعدیل دستی اخیر حساب" value={info.financialEvidence.adjustments.map(row =>
                <div key={row.id}><bdi>{row.id}</bdi> · {formatToman(row.amountRial / 10)} · {timeLabel(row.createdAt)}</div>)} />
            </dl>
          </Panel>}
        </div>
        <div className="admin-detail-side"><Panel title="اطلاعات مشتری"><Customer user={info.user} /></Panel>
          <Panel title="صورتحساب"><Field label="شماره فاکتور" value={info.invoice?.number ?? '—'} /><Field label="وضعیت" value={info.invoice?.status ?? '—'} /></Panel>
        </div>
      </div> : null}
    </State>
  </div>
}

export function AdminServerPage() {
  const { id = '' } = useParams()
  const result = useApiQuery(() => adminApi.server(id), [id])
  const info = result.data
  return <div className="admin-page">
    <Heading title="جزئیات سرور" subtitle="مشخصات سرویس، وضعیت و ارتباط با مالک"
      actions={<ReturnLink to="/admin/servers">بازگشت به سرورها</ReturnLink>} />
    <State loading={result.loading} error={result.error} empty={!info} retry={result.refetch}>
      {info ? <div className="admin-detail-grid">
        <div className="admin-detail-content">
          <Panel title={info.server.name} action={<Status kind="server" status={info.server.status} />}>
            <dl className="admin-info-grid">
              <Field label="IPv4" value={info.server.ipv4 || '—'} ltr /><Field label="IPv6" value={info.server.ipv6 || '—'} ltr />
              <Field label="ارائه‌دهنده" value={info.server.provider} ltr /><Field label="موقعیت" value={info.server.providerLocation} ltr />
              <Field label="پردازنده" value={`${info.server.vcpu} vCPU`} ltr />
              <Field label="حافظه" value={`${formatFaNumber(info.server.memoryMb / 1024)} GB`} ltr />
              <Field label="فضای دیسک" value={`${formatFaNumber(info.server.diskGb)} GB`} ltr />
              <Field label="سیستم‌عامل" value={info.server.operatingSystem} ltr />
              <Field label="تاریخ ایجاد" value={dateLabel(info.server.createdAt)} />
              <Field label="آخرین همگام‌سازی" value={timeLabel(info.server.lastSyncedAt)} />
            </dl>
          </Panel>
          {info.legacyPowerOperation && <Panel title="بررسی عملیات برق بدون رسید">
            <LegacyPowerReview key={info.legacyPowerOperation.id} serverId={info.server.id} operation={info.legacyPowerOperation} onResolved={result.refetch} />
          </Panel>}
        </div>
        <div className="admin-detail-side"><Panel title="مالک سرور"><Customer user={info.owner} /></Panel>
          <Panel title="ارتباط با سفارش">
            <Link className="admin-secondary-link" to={`/admin/orders/${info.server.orderId}`}>مشاهده سفارش <ArrowLeft size={17} /></Link>
          </Panel>
        </div>
      </div> : null}
    </State>
  </div>
}
