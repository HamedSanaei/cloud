import { useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from './api'
import { useApiQuery } from '../hooks/useApiQuery'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Select } from '../components/ui/FormControls'
import type { Ticket } from '../lib/types'

export function AdminTickets() {
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<(Ticket & { ownerEmail: string }) | null>(null)
  const tickets = useApiQuery(() => adminApi.tickets({ page, status, search: '' }), [page, status])
  return <div className="page-stack"><h1>تیکت‌های پشتیبانی</h1>
    <Select label="وضعیت تیکت" value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="">همه</option><option value="pending">در انتظار</option><option value="review">در حال بررسی</option><option value="answered">پاسخ داده شده</option><option value="closed">بسته شده</option></Select>
    {tickets.loading ? <p role="status">در حال دریافت…</p> : tickets.error ? <p role="alert">دریافت تیکت‌ها ناموفق بود.</p> : tickets.data?.items.map(ticket => <section className="card" key={ticket.id}>
      <h2>{ticket.title}</h2><p>{ticket.ownerEmail}</p><p>سرور مربوطه: {ticket.relatedServer?.name ?? 'سفارشی ندارم'}</p><Button variant="secondary" onClick={() => setDetail(ticket)}>مشاهده جزئیات</Button>
    </section>)}
    {!tickets.loading && tickets.data?.total === 0 ? <p>تیکتی یافت نشد.</p> : null}
    <div className="wizard-card__footer"><Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>قبلی</Button><Button disabled={!tickets.data || page >= tickets.data.pages} onClick={() => setPage(p => p + 1)}>بعدی</Button></div>
    <Modal open={!!detail} title={detail?.title || 'جزئیات تیکت'} onClose={() => setDetail(null)}>{detail ? <div className="form-stack"><p>{detail.ownerEmail}</p><p style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</p><strong>{detail.relatedServer?.name ?? 'سفارشی ندارم'}</strong>
      {detail.relatedServer ? <p dir="ltr">{detail.relatedServer.id} · {detail.relatedServer.ip}</p> : null}
      {detail.serverId ? <Link to={`/admin/servers/${detail.serverId}`}>مشاهده سرور در مدیریت</Link> : detail.relatedServer ? <p>سرور حذف شده است؛ اطلاعات تاریخی درخواست محفوظ است.</p> : null}</div> : null}</Modal>
  </div>
}
