import { Clock3, Inbox, LifeBuoy, MessageCircleReply, Plus, SearchCheck } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { CopyableIp } from '../components/ui/CopyableIp'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { HistoryPagination } from '../components/ui/HistoryPagination'
import { Input, Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'
import { useApiQuery } from '../hooks/useApiQuery'
import { useCustomerHistory } from '../hooks/useCustomerHistory'
import { isApiConfigured } from '../lib/apiClient'
import { createTicket, getTicket, getTicketSummary, listTickets, listTicketServers, markTicketRepliesRead } from '../lib/endpoints'
import { ticketDepartmentLabel, ticketDepartmentLabels, ticketStatusLabel, ticketStatusLabels } from '../lib/tickets'
import { formatCount } from '../lib/format'
import { normalizeSearchText } from '../../backend/src/contracts/search-text'

export function TicketsPage() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [department, setDepartment] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [ticketDepartment, setTicketDepartment] = useState('technical')
  const [description, setDescription] = useState('')
  const [serverId, setServerId] = useState('')
  const [search, setSearch] = useSearchParams()
  const linkedId = search.get('ticket')
  const linked = useApiQuery(() => linkedId ? getTicket(linkedId) : Promise.resolve(null), [linkedId])
  const selected = linkedId && linked.data?.id === linkedId ? linked.data : null
  const closeDetail = () => setSearch({}, { replace: true })
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  const summary = useApiQuery(getTicketSummary)
  const tickets = useCustomerHistory(listTickets, { search: query, status, department }, 'tickets')
  const { search: queryText, resetPage } = tickets
  const servers = useApiQuery(() => modalOpen ? listTicketServers() : Promise.resolve([]), [modalOpen])
  const refreshTickets = tickets.refetch
  const refreshSummary = summary.refetch
  useEffect(() => {
    if (!selected?.unread) return
    const ids = selected.replies?.filter(reply => reply.read === false).map(reply => reply.id) ?? []
    if (ids.length) void markTicketRepliesRead(selected.id, ids).then(() => {
      refreshTickets()
      refreshSummary()
    }).catch(() => { /* Leave the replies unread if the receipt fails. */ })
  }, [selected, refreshTickets, refreshSummary])

  const filtered = useMemo(() => {
    const items = tickets.data?.items ?? []
    if (tickets.data?.pagination) return items
    return items.filter((ticket) => {
      const matchesQuery = !queryText || normalizeSearchText(ticket.title).includes(queryText)
      const matchesStatus = status === 'all' || ticket.status === status
      const matchesDepartment = department === 'all' || ticket.department === department
      return matchesQuery && matchesStatus && matchesDepartment
    })
  }, [tickets.data, queryText, status, department])

  const submitTicket = async (event: FormEvent) => {
    event.preventDefault()
    if (!isApiConfigured()) {
      setModalOpen(false)
      setTitle('')
      setDescription('')
      showToast('تیکت آزمایشی با موفقیت ثبت شد.')
      return
    }
    setSubmitting(true)
    try {
      await createTicket({ title, department: ticketDepartment, description, serverId: serverId || null })
      setModalOpen(false)
      setTitle('')
      setDescription('')
      setServerId('')
      tickets.refetch()
      summary.refetch()
      window.dispatchEvent(new Event('notifications-changed'))
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ثبت تیکت ناموفق بود.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="تیکت‌ها"
        subtitle="مدیریت تیکت‌های پشتیبانی"
        icon={<LifeBuoy />}
        actions={<Button icon={<Plus size={18} />} onClick={() => setModalOpen(true)}>تیکت جدید</Button>}
      />

      <div className="metrics-grid metrics-grid--five">
        <MetricCard label="کل تیکت‌ها" value={formatCount(summary.data?.total ?? tickets.data?.items.length ?? 0)} icon={LifeBuoy} />
        <MetricCard label="باز" value={formatCount(summary.data?.open ?? 0)} icon={Inbox} accent="amber" />
        <MetricCard label="در حال بررسی" value={formatCount(summary.data?.reviewing ?? 0)} icon={Clock3} accent="cyan" />
        <MetricCard label="پاسخ داده شده" value={formatCount(summary.data?.answered ?? 0)} icon={MessageCircleReply} accent="green" />
        <MetricCard label="خوانده نشده" value={formatCount(summary.data?.unread ?? 0)} icon={SearchCheck} accent="purple" />
      </div>

      <FilterPanel
        query={query}
        onQueryChange={value => { setQuery(value); resetPage() }}
        placeholder="جستجو در تیکت‌ها..."
        onReset={() => { setQuery(''); setStatus('all'); setDepartment('all'); resetPage() }}
      >
        <Select aria-label="وضعیت" value={status} onChange={(event) => { setStatus(event.target.value); resetPage() }}>
          <option value="all">همه وضعیت‌ها</option>
          {Object.entries(ticketStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Select aria-label="بخش" value={department} onChange={(event) => { setDepartment(event.target.value); resetPage() }}>
          <option value="all">همه بخش‌ها</option>
          {Object.entries(ticketDepartmentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </FilterPanel>

      <Card>
        <SectionHeading title="لیست تیکت‌ها" />
        {tickets.loading ? (
          <LoadingState label="در حال دریافت تیکت‌ها..." />
        ) : tickets.error ? (
          <QueryError message={tickets.error} onRetry={tickets.refetch} />
        ) : !filtered.length ? (
          <EmptyState
            icon={LifeBuoy}
            title="تیکتی یافت نشد"
            description={query || status !== 'all' || department !== 'all' ? 'عبارت جستجو یا فیلترها را تغییر دهید.' : 'هنوز هیچ تیکتی ایجاد نکرده‌اید.'}
            action={<Button icon={<Plus size={17} />} onClick={() => setModalOpen(true)}>ایجاد تیکت جدید</Button>}
          />
        ) : (
          <Table headers={['عنوان', 'بخش', 'سرور مربوطه', 'وضعیت', 'جزئیات']}>
            {filtered.map((ticket) => (
              <tr key={ticket.id}>
                <td>{ticket.title}{ticket.unread && <> <Badge tone="info">پاسخ خوانده‌نشده</Badge></>}</td>
                <td>{ticketDepartmentLabel(ticket.department)}</td>
                <td>{ticket.relatedServer?.name ?? 'سفارشی ندارم'}</td>
                <td><Badge>{ticketStatusLabel(ticket.status)}</Badge></td>
                <td><Button variant="secondary" size="sm" onClick={() => setSearch({ ticket: ticket.id })}>مشاهده تیکت</Button></td>
              </tr>
            ))}
          </Table>
        )}
        {!tickets.loading && !tickets.error && <HistoryPagination label="صفحه‌بندی تیکت‌ها" {...tickets} />}
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="تیکت پشتیبانی جدید"
        description="موضوع را انتخاب کنید و شرح درخواست خود را بنویسید."
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>انصراف</Button><Button type="submit" form="ticket-form" disabled={submitting}>{submitting ? 'در حال ثبت...' : 'ثبت تیکت'}</Button></>}
      >
        <form id="ticket-form" className="form-stack" onSubmit={submitTicket}>
          <Input label="عنوان تیکت" placeholder="عنوان کوتاه و واضح" required value={title} onChange={(event) => setTitle(event.target.value)} />
          <Select label="بخش مربوطه" required value={ticketDepartment} onChange={(event) => setTicketDepartment(event.target.value)}><option value="technical">پشتیبانی فنی</option><option value="finance">امور مالی</option><option value="sales">فروش</option></Select>
          <Select label="سرور مربوطه" value={serverId} onChange={event => setServerId(event.target.value)}>
            <option value="">سفارشی ندارم</option>
            {servers.data?.map(server => <option key={server.id} value={server.id}>{server.name} — {server.ip || server.id.slice(0, 8)}</option>)}
          </Select>
          {servers.loading ? <p role="status">در حال دریافت سرورهای شما…</p> : servers.error ? <p role="status">دریافت سرورها ممکن نشد؛ می‌توانید «سفارشی ندارم» را انتخاب و درخواست را ثبت کنید.</p> : null}
          <label className="field"><span className="field__label">شرح درخواست</span><textarea className="textarea" rows={5} placeholder="جزئیات درخواست خود را بنویسید..." required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </form>
      </Modal>
      <Modal open={!!selected || !!linkedId} onClose={closeDetail} title={selected?.title || 'جزئیات تیکت'}>
        {selected ? <div className="form-stack"><p>{selected.description}</p>{selected.replies?.map(reply => <article key={reply.id}><strong>پاسخ پشتیبانی — {new Date(reply.createdAt).toLocaleString('fa-IR')}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{reply.body}</p></article>)}<strong>سرور مربوطه: {selected.relatedServer?.name ?? 'سفارشی ندارم'}</strong>
          {selected.relatedServer ? <><CopyableIp value={selected.relatedServer.ip} />{!selected.serverId ? <p>این سرور حذف شده است؛ اطلاعات زمان ثبت درخواست نگه داشته شده است.</p> : null}</> : null}</div>
          : linked.error ? <QueryError message={linked.error} onRetry={linked.refetch} /> : <LoadingState label="در حال دریافت تیکت…" />}
      </Modal>
    </div>
  )
}
