import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Search } from 'lucide-react'
import { useApiQuery } from '../hooks/useApiQuery'
import { adminApi } from './api'
import { formatCount, formatFaNumber } from '../lib/format'

const statusLabels: Record<string, string> = {
  active: 'روشن', suspended: 'خاموش', provisioning: 'در حال پردازش',
  terminated: 'حذف‌شده', failed: 'خطا', unknown: 'نامشخص',
}

/** Admin-only: directly discovered Hetzner machines are NOT automatically
 * assigned to website users or billed in the website ledger. */
export function HetznerInventoryPanel() {
  const fleet = useApiQuery(adminApi.hetznerInventory)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => (fleet.data?.items ?? []).filter(s =>
    [s.name, s.providerServerId, s.accountId, s.ipv4 ?? '', s.location ?? '']
      .some(v => v.toLowerCase().includes(query.trim().toLowerCase())),
  ), [fleet.data, query])
  const perPage = 20
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const visible = filtered.slice((Math.min(page, pages) - 1) * perPage, Math.min(page, pages) * perPage)
  return <section className="admin-panel" aria-label="موجودی کامل هتزنر">
    <header className="admin-panel__heading">
      <div>
        <h2>تمام سرورهای Hetzner Cloud</h2>
        <p>شامل سرورهای ساخته‌شده در سایت و مستقیم در پنل هتزنر؛ از تمام پروژه‌های دارای توکن API. نمایش فقط برای مدیر.</p>
      </div>
      <button type="button" className="admin-secondary-link" disabled={fleet.loading} onClick={fleet.refetch}>
        <RefreshCw size={16} /> {fleet.loading ? 'در حال همگام‌سازی…' : 'همگام‌سازی با هتزنر'}
      </button>
    </header>
    {fleet.loading && !fleet.data ? <p className="admin-state" role="status">در حال خواندن سرورهای تمام پروژه‌های هتزنر…</p> : null}
    {fleet.error ? <div className="admin-state admin-state--error" role="alert">
      <p>{fleet.error}</p><button type="button" onClick={fleet.refetch}>تلاش دوباره</button>
    </div> : null}
    {fleet.data ? <>
      <div className="admin-filters">
        <label className="admin-search"><Search size={18}/><input aria-label="جست‌وجوی سرورهای هتزنر"
          value={query} onChange={e => { setQuery(e.target.value); setPage(1) }}
          placeholder="نام، آی‌پی، شناسه یا پروژه…" /></label>
      </div>
      <p className="admin-muted">
        {formatCount(fleet.data.items.length)} سرور در {formatCount(fleet.data.accounts)} پروژه/حساب ·
        آخرین همگام‌سازی: {new Date(fleet.data.syncedAt).toLocaleString('fa-IR')}
      </p>
      {visible.length ? <>
        <div className="admin-table-scroll"><table className="admin-table">
          <thead><tr><th>سرور</th><th>منبع</th><th>پروژه / حساب</th><th>IP</th><th>مشخصات</th><th>موقعیت</th><th>وضعیت</th></tr></thead>
          <tbody>{visible.map(s => <tr key={s.providerServerId}>
            <td dir="ltr">{s.websiteServerId ? <Link to={`/admin/servers/${s.websiteServerId}`}>{s.name}</Link> : s.name}</td>
            <td>{s.source === 'website' ? 'سایت' : 'هتزنر مستقیم · بدون مالک سایت'}</td>
            <td dir="ltr">{s.accountId}</td><td dir="ltr">{s.ipv4 || s.ipv6 || '—'}</td>
            <td dir="ltr">{s.vcpu ?? '—'} vCPU · {s.memoryMb == null ? '—' : formatFaNumber(s.memoryMb / 1024)} GB · {s.diskGb ?? '—'} GB</td>
            <td dir="ltr">{s.location ?? '—'}</td><td>{statusLabels[s.status] ?? s.status}</td>
          </tr>)}</tbody>
        </table></div>
        {pages > 1 ? <div className="admin-pager">
          <span>صفحه {formatCount(Math.min(page, pages))} از {formatCount(pages)}</span>
          <div><button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>قبلی</button>
            <button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>بعدی</button></div>
        </div> : null}
      </> : <p className="admin-state">{query ? 'موردی مطابق جست‌وجو یافت نشد.' : 'در پروژه‌های تنظیم‌شده سروری یافت نشد.'}</p>}
    </> : null}
  </section>
}
