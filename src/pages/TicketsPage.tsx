import { Clock3, Inbox, LifeBuoy, MessageCircleReply, Plus, SearchCheck } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Input, Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'
import { useApiQuery } from '../hooks/useApiQuery'
import { isApiConfigured } from '../lib/apiClient'
import { createTicket, getTicketSummary, listTickets } from '../lib/endpoints'
import { formatCount } from '../lib/format'

export function TicketsPage() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [department, setDepartment] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [ticketDepartment, setTicketDepartment] = useState('technical')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()

  const summary = useApiQuery(getTicketSummary)
  const tickets = useApiQuery(listTickets)

  const filtered = useMemo(() => {
    const items = tickets.data ?? []
    const normalized = query.trim()
    return items.filter((ticket) => {
      const matchesQuery = !normalized || ticket.title.includes(normalized)
      const matchesStatus = status === 'all' || ticket.status === status
      const matchesDepartment = department === 'all' || ticket.department === department
      return matchesQuery && matchesStatus && matchesDepartment
    })
  }, [tickets.data, query, status, department])

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
      await createTicket({ title, department: ticketDepartment, description })
      setModalOpen(false)
      setTitle('')
      setDescription('')
      tickets.refetch()
      summary.refetch()
      showToast('تیکت با موفقیت ثبت شد.')
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
        <MetricCard label="کل تیکت‌ها" value={formatCount(summary.data?.total ?? tickets.data?.length ?? 0)} icon={LifeBuoy} />
        <MetricCard label="باز" value={formatCount(summary.data?.open ?? 0)} icon={Inbox} accent="amber" />
        <MetricCard label="در حال بررسی" value={formatCount(summary.data?.reviewing ?? 0)} icon={Clock3} accent="cyan" />
        <MetricCard label="پاسخ داده شده" value={formatCount(summary.data?.answered ?? 0)} icon={MessageCircleReply} accent="green" />
        <MetricCard label="خوانده نشده" value={formatCount(summary.data?.unread ?? 0)} icon={SearchCheck} accent="purple" />
      </div>

      <FilterPanel
        query={query}
        onQueryChange={setQuery}
        placeholder="جستجو در تیکت‌ها..."
        onReset={() => { setQuery(''); setStatus('all'); setDepartment('all') }}
      >
        <Select aria-label="وضعیت" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">همه وضعیت‌ها</option><option value="pending">در انتظار</option><option value="review">در حال بررسی</option><option value="answered">پاسخ داده شده</option><option value="closed">بسته شده</option>
        </Select>
        <Select aria-label="بخش" value={department} onChange={(event) => setDepartment(event.target.value)}>
          <option value="all">همه بخش‌ها</option><option value="technical">فنی</option><option value="finance">مالی</option>
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
          <Table headers={['عنوان', 'بخش', 'وضعیت']}>
            {filtered.map((ticket) => (
              <tr key={ticket.id}>
                <td>{ticket.title}</td>
                <td>{ticket.department}</td>
                <td><Badge>{ticket.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
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
          <label className="field"><span className="field__label">شرح درخواست</span><textarea className="textarea" rows={5} placeholder="جزئیات درخواست خود را بنویسید..." required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        </form>
      </Modal>
    </div>
  )
}
