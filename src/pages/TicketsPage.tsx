import { Clock3, Inbox, LifeBuoy, MessageCircleReply, Plus, SearchCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Input, Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState } from '../components/ui/States'
import { useToast } from '../components/ui/Toast'

export function TicketsPage() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [department, setDepartment] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const { showToast } = useToast()

  const submitTicket = (event: FormEvent) => {
    event.preventDefault()
    setModalOpen(false)
    showToast('تیکت آزمایشی با موفقیت ثبت شد.')
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
        <MetricCard label="کل تیکت‌ها" value="۰" icon={LifeBuoy} />
        <MetricCard label="باز" value="۰" icon={Inbox} accent="amber" />
        <MetricCard label="در حال بررسی" value="۰" icon={Clock3} accent="cyan" />
        <MetricCard label="پاسخ داده شده" value="۰" icon={MessageCircleReply} accent="green" />
        <MetricCard label="خوانده نشده" value="۰" icon={SearchCheck} accent="purple" />
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
        <EmptyState
          icon={LifeBuoy}
          title="تیکتی یافت نشد"
          description={query ? 'عبارت جستجو یا فیلترها را تغییر دهید.' : 'هنوز هیچ تیکتی ایجاد نکرده‌اید.'}
          action={<Button icon={<Plus size={17} />} onClick={() => setModalOpen(true)}>ایجاد تیکت جدید</Button>}
        />
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="تیکت پشتیبانی جدید"
        description="موضوع را انتخاب کنید و شرح درخواست خود را بنویسید."
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>انصراف</Button><Button type="submit" form="ticket-form">ثبت تیکت</Button></>}
      >
        <form id="ticket-form" className="form-stack" onSubmit={submitTicket}>
          <Input label="عنوان تیکت" placeholder="عنوان کوتاه و واضح" required />
          <Select label="بخش مربوطه" required><option>پشتیبانی فنی</option><option>امور مالی</option><option>فروش</option></Select>
          <label className="field"><span className="field__label">شرح درخواست</span><textarea className="textarea" rows={5} placeholder="جزئیات درخواست خود را بنویسید..." required /></label>
        </form>
      </Modal>
    </div>
  )
}
