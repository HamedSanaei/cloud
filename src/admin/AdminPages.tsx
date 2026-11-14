import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ClipboardList, HardDrive, Search, Server, Users } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatCount, formatFaNumber, formatToman } from '../lib/format'
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
  active: 'فعال', failed: 'ناموفق', cancelled: 'لغوشده',
  requires_review: 'نیازمند بررسی', refunded: 'بازپرداخت‌شده',
}
const serverLabels: Record<string, string> = {
  active: 'فعال', provisioning: 'در حال ساخت', suspended: 'خاموش / تعلیق',
  terminated: 'خاتمه‌یافته', failed: 'خطا',
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
  return <div className="admin-page">
    <Heading title="نمای کلی" subtitle="وضعیت کاربران، سفارش‌ها و زیرساخت در یک نگاه" />
    <State loading={info.loading} error={info.error} empty={false} retry={info.refetch}>
      {info.data ? <>
        <div className="admin-metrics">
          <div className="admin-metric"><span>کاربران ثبت‌شده</span><strong>{formatCount(info.data.users)}</strong><small><Users size={15} /> حساب‌های سایت</small></div>
          <div className="admin-metric"><span>سفارش‌های ثبت‌شده</span><strong>{formatCount(info.data.orders)}</strong><small><ClipboardList size={15} /> {formatCount(info.data.ordersNeedingAttention)} نیازمند پیگیری</small></div>
          <div className="admin-metric"><span>سرورهای فعال</span><strong>{formatCount(info.data.activeServers)}</strong><small><Server size={15} /> از {formatCount(info.data.servers)} سرور</small></div>
          <div className="admin-metric"><span>مبلغ سفارش‌های پرداخت‌شده</span><strong>{formatFaNumber(info.data.paidOrderTotalToman)}</strong><small>تومان · بدون احتساب سفارش‌های تسویه‌نشده</small></div>
        </div>
        <div className="admin-overview-grid">
          <Panel title="آخرین سفارش‌ها" subtitle="پیگیری وضعیت سفارش‌های ثبت‌شده" action={<Link className="admin-text-link" to="/admin/orders">مشاهده همه</Link>}>
            <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>شماره سفارش</th><th>کاربر</th><th>مبلغ</th><th>وضعیت</th></tr></thead>
              <tbody>{info.data.recentOrders.map(o => <tr key={o.id}>
                <td><Link to={`/admin/orders/${o.id}`}>{o.orderNumber}</Link></td><td>{o.userName}</td>
                <td>{formatToman(o.totalToman)}</td><td><Status status={o.status} kind="order" /></td>
              </tr>)}</tbody></table></div>
            {!info.data.recentOrders.length ? <div className="admin-state">هنوز سفارشی ثبت نشده است.</div> : null}
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
  const walletNames = new Map(info?.wallets.map(wallet => [wallet.id, wallet.name]))
  return <div className="admin-page">
    <Heading title="پروفایل کاربر" subtitle="مشاهده اطلاعات حساب، کیف پول و سرورهای متعلق به کاربر"
      actions={<ReturnLink to="/admin/users">بازگشت به کاربران</ReturnLink>} />
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
            <div className="admin-profile-status"><Status status={info.user.status} kind="user" /></div>
            <dl className="admin-fields">
              <Field label="ایمیل" value={info.user.email} ltr />
              <Field label="شماره همراه" value={info.user.mobile || 'ثبت نشده'} ltr />
              <Field label="زمان عضویت" value={dateLabel(info.user.createdAt)} />
              <Field label="تأیید ایمیل" value={info.user.emailVerifiedAt ? 'تأیید شده' : 'تأیید نشده'} />
              <Field label="تأیید موبایل" value={info.user.mobileVerifiedAt ? 'تأیید شده' : 'تأیید نشده'} />
            </dl>
          </Panel>
        </div>
      </div> : null}
    </State>
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
