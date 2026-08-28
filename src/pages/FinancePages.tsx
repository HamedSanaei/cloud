import {
  ArrowDownToLine,
  CircleDollarSign,
  CreditCard,
  Download,
  FileText,
  Plus,
  ReceiptText,
  WalletCards,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState } from '../components/ui/States'
import { Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'

export function WalletPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [defaultWallet, setDefaultWallet] = useState(true)
  const [period, setPeriod] = useState('24h')
  const { showToast } = useToast()

  const createWallet = (event: FormEvent) => {
    event.preventDefault()
    setModalOpen(false)
    showToast('کیف پول نمونه ایجاد شد.')
  }

  return (
    <div className="page-stack">
      <PageHeader title="کیف پول 💰" subtitle="مدیریت کیف پول‌ها و موجودی حساب کاربری" icon={<WalletCards />} actions={<Button icon={<Plus size={18} />} onClick={() => setModalOpen(true)}>کیف پول جدید</Button>} />
      <div className="metrics-grid metrics-grid--four">
        <MetricCard label="موجودی کل" value="۰ تومان" icon={CircleDollarSign} accent="green" />
        <MetricCard label="کیف پول‌ها" value="۰" icon={WalletCards} />
        <MetricCard label="کیف پول پیش‌فرض" value="پیش‌فرض" icon={CreditCard} accent="cyan" />
        <MetricCard label="محصول متصل‌شده" value="۰" icon={ReceiptText} accent="purple" />
      </div>

      <Card>
        <SectionHeading title="کیف پول‌ها" action={<Button size="sm" icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>ایجاد کیف پول</Button>} />
        <EmptyState compact icon={WalletCards} title="هیچ کیف پولی یافت نشد" description="برای شروع، یک کیف پول جدید ایجاد کنید." />
      </Card>

      <Card>
        <SectionHeading title="تراکنش‌ها" action={<Button variant="secondary" size="sm" icon={<Download size={16} />} onClick={() => showToast('فایل گزارش آزمایشی آماده شد.')}>دانلود</Button>} />
        <div className="segmented-filter">
          <button type="button" className={period === '24h' ? 'active' : ''} onClick={() => setPeriod('24h')}>۲۴ ساعت اخیر</button>
          <button type="button" className={period === '7d' ? 'active' : ''} onClick={() => setPeriod('7d')}>۷ روز اخیر</button>
          <Select aria-label="کیف پول"><option>همه کیف پول‌ها</option></Select>
        </div>
        <Table headers={['شرح', 'کیف پول', 'مبلغ', 'تاریخ', 'وضعیت']}>
          <tr className="table-empty"><td colSpan={5}>هیچ تراکنشی یافت نشد</td></tr>
        </Table>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="ایجاد کیف پول جدید"
        description="برای تفکیک هزینه‌ها یک کیف پول مستقل بسازید."
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>انصراف</Button><Button type="submit" form="wallet-form">ایجاد کیف پول</Button></>}
      >
        <form id="wallet-form" className="form-stack" onSubmit={createWallet}>
          <Input label="نام کیف پول" placeholder="مثلاً پروژه اصلی" required />
          <Input label="توضیحات" placeholder="توضیح اختیاری" />
          <Toggle checked={defaultWallet} onChange={setDefaultWallet} label="به عنوان کیف پول پیش‌فرض انتخاب شود" />
        </form>
      </Modal>
    </div>
  )
}

interface FinancialListProps {
  type: 'invoice' | 'charge'
}

function FinancialList({ type }: FinancialListProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const isInvoice = type === 'invoice'
  const Icon = isInvoice ? FileText : CreditCard

  return (
    <div className="page-stack">
      <PageHeader
        title={isInvoice ? 'فاکتورها 📄' : 'درخواست‌های شارژ 💳'}
        subtitle={isInvoice ? 'مشاهده و مدیریت فاکتورهای شما' : 'مشاهده وضعیت درخواست‌های واریز به کیف پول'}
        icon={<Icon />}
      />
      <FilterPanel
        query={query}
        onQueryChange={setQuery}
        placeholder={isInvoice ? 'جستجو در شماره فاکتور یا توضیحات...' : 'جستجو در شماره درخواست یا فاکتور...'}
        onReset={() => { setQuery(''); setStatus('all') }}
      >
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="وضعیت">
          <option value="all">همه وضعیت‌ها</option>
          {isInvoice ? <><option>در انتظار پرداخت</option><option>پرداخت شده</option><option>لغو شده</option><option>مسترد شده</option></> : <><option>در انتظار</option><option>تایید شده</option><option>رد شده</option><option>در حال پردازش</option></>}
        </Select>
      </FilterPanel>
      <Card>
        <SectionHeading title={isInvoice ? 'لیست فاکتورها' : 'لیست درخواست‌ها'} />
        <EmptyState
          icon={isInvoice ? FileText : ArrowDownToLine}
          title={isInvoice ? 'فاکتوری یافت نشد' : 'درخواست شارژی یافت نشد'}
          description={query ? 'فیلتر یا عبارت جستجو را تغییر دهید.' : isInvoice ? 'فاکتورهای صادرشده در این بخش نمایش داده می‌شوند.' : 'پس از ثبت واریز، وضعیت درخواست اینجا نمایش داده می‌شود.'}
        />
      </Card>
    </div>
  )
}

export function InvoicesPage() {
  return <FinancialList type="invoice" />
}

export function ChargeRequestsPage() {
  return <FinancialList type="charge" />
}
