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
import { useMemo, useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'
import { useApiQuery } from '../hooks/useApiQuery'
import { isApiConfigured } from '../lib/apiClient'
import { createWallet, getWalletSummary, listChargeRequests, listInvoices, listTransactions, listWallets } from '../lib/endpoints'
import { formatCount, formatToman } from '../lib/format'

export function WalletPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [defaultWallet, setDefaultWallet] = useState(true)
  const [walletName, setWalletName] = useState('')
  const [walletDescription, setWalletDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [period, setPeriod] = useState('24h')
  const { showToast } = useToast()

  const summary = useApiQuery(getWalletSummary)
  const wallets = useApiQuery(listWallets)
  const transactions = useApiQuery(listTransactions)

  const createWalletSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isApiConfigured()) {
      setModalOpen(false)
      setWalletName('')
      setWalletDescription('')
      showToast('کیف پول نمونه ایجاد شد.')
      return
    }
    setCreating(true)
    try {
      await createWallet({ name: walletName, description: walletDescription || undefined, isDefault: defaultWallet })
      setModalOpen(false)
      setWalletName('')
      setWalletDescription('')
      wallets.refetch()
      summary.refetch()
      showToast('کیف پول با موفقیت ایجاد شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ایجاد کیف پول ناموفق بود.')
    } finally {
      setCreating(false)
    }
  }

  const summaryData = summary.data

  return (
    <div className="page-stack">
      <PageHeader title="کیف پول 💰" subtitle="مدیریت کیف پول‌ها و موجودی حساب کاربری" icon={<WalletCards />} actions={<Button icon={<Plus size={18} />} onClick={() => setModalOpen(true)}>کیف پول جدید</Button>} />
      <div className="metrics-grid metrics-grid--four">
        <MetricCard label="موجودی کل" value={summary.loading ? '...' : formatToman(summaryData?.totalBalance ?? 0)} icon={CircleDollarSign} accent="green" />
        <MetricCard label="کیف پول‌ها" value={summary.loading ? '...' : formatCount(summaryData?.wallets ?? wallets.data?.length ?? 0)} icon={WalletCards} />
        <MetricCard label="کیف پول پیش‌فرض" value={summaryData?.defaultWallet ?? 'پیش‌فرض'} icon={CreditCard} accent="cyan" />
        <MetricCard label="محصول متصل‌شده" value={summary.loading ? '...' : formatCount(summaryData?.connectedProducts ?? 0)} icon={ReceiptText} accent="purple" />
      </div>

      <Card>
        <SectionHeading title="کیف پول‌ها" action={<Button size="sm" icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>ایجاد کیف پول</Button>} />
        {wallets.loading ? (
          <LoadingState label="در حال دریافت کیف پول‌ها..." />
        ) : wallets.error ? (
          <QueryError message={wallets.error} onRetry={wallets.refetch} />
        ) : !wallets.data?.length ? (
          <EmptyState compact icon={WalletCards} title="هیچ کیف پولی یافت نشد" description="برای شروع، یک کیف پول جدید ایجاد کنید." />
        ) : (
          <Table headers={['نام', 'موجودی', 'وضعیت']}>
            {wallets.data.map((wallet) => (
              <tr key={wallet.id}>
                <td>{wallet.name}</td>
                <td>{formatToman(wallet.balance)}</td>
                <td>{wallet.isDefault ? <Badge tone="info">پیش‌فرض</Badge> : <Badge>عادی</Badge>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <SectionHeading title="تراکنش‌ها" action={<Button variant="secondary" size="sm" icon={<Download size={16} />} onClick={() => showToast('فایل گزارش آزمایشی آماده شد.')}>دانلود</Button>} />
        <div className="segmented-filter">
          <button type="button" className={period === '24h' ? 'active' : ''} onClick={() => setPeriod('24h')}>۲۴ ساعت اخیر</button>
          <button type="button" className={period === '7d' ? 'active' : ''} onClick={() => setPeriod('7d')}>۷ روز اخیر</button>
          <Select aria-label="کیف پول"><option>همه کیف پول‌ها</option></Select>
        </div>
        {transactions.loading ? (
          <LoadingState label="در حال دریافت تراکنش‌ها..." />
        ) : transactions.error ? (
          <QueryError message={transactions.error} onRetry={transactions.refetch} />
        ) : !transactions.data?.length ? (
          <Table headers={['شرح', 'کیف پول', 'مبلغ', 'تاریخ', 'وضعیت']}>
            <tr className="table-empty"><td colSpan={5}>هیچ تراکنشی یافت نشد</td></tr>
          </Table>
        ) : (
          <Table headers={['شرح', 'کیف پول', 'مبلغ', 'تاریخ', 'وضعیت']}>
            {transactions.data.map((transaction) => (
              <tr key={transaction.id}>
                <td>{transaction.description}</td>
                <td>{transaction.wallet}</td>
                <td>{formatToman(transaction.amount)}</td>
                <td>{transaction.date}</td>
                <td><Badge>{transaction.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="ایجاد کیف پول جدید"
        description="برای تفکیک هزینه‌ها یک کیف پول مستقل بسازید."
        footer={<><Button variant="secondary" onClick={() => setModalOpen(false)}>انصراف</Button><Button type="submit" form="wallet-form" disabled={creating}>{creating ? 'در حال ایجاد...' : 'ایجاد کیف پول'}</Button></>}
      >
        <form id="wallet-form" className="form-stack" onSubmit={createWalletSubmit}>
          <Input label="نام کیف پول" placeholder="مثلاً پروژه اصلی" required value={walletName} onChange={(event) => setWalletName(event.target.value)} />
          <Input label="توضیحات" placeholder="توضیح اختیاری" value={walletDescription} onChange={(event) => setWalletDescription(event.target.value)} />
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

  const invoices = useApiQuery(listInvoices, [type])
  const charges = useApiQuery(listChargeRequests, [type])
  const active = isInvoice ? invoices : charges

  const rows = useMemo(() => {
    const items = (active.data ?? []) as Array<{ number: string; description?: string; invoiceNumber?: string; status: string; amount: number; date: string; id: string }>
    const normalized = query.trim()
    return items.filter((item) => {
      const haystack = `${item.number} ${item.description ?? ''} ${item.invoiceNumber ?? ''}`
      const matchesQuery = !normalized || haystack.includes(normalized)
      const matchesStatus = status === 'all' || item.status === status
      return matchesQuery && matchesStatus
    })
  }, [active.data, query, status])

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
          {isInvoice ? <><option value="pending">در انتظار پرداخت</option><option value="paid">پرداخت شده</option><option value="cancelled">لغو شده</option><option value="refunded">مسترد شده</option></> : <><option value="pending">در انتظار</option><option value="approved">تایید شده</option><option value="rejected">رد شده</option><option value="processing">در حال پردازش</option></>}
        </Select>
      </FilterPanel>
      <Card>
        <SectionHeading title={isInvoice ? 'لیست فاکتورها' : 'لیست درخواست‌ها'} />
        {active.loading ? (
          <LoadingState label="در حال دریافت..." />
        ) : active.error ? (
          <QueryError message={active.error} onRetry={active.refetch} />
        ) : !rows.length ? (
          <EmptyState
            icon={isInvoice ? FileText : ArrowDownToLine}
            title={isInvoice ? 'فاکتوری یافت نشد' : 'درخواست شارژی یافت نشد'}
            description={query || status !== 'all' ? 'فیلتر یا عبارت جستجو را تغییر دهید.' : isInvoice ? 'فاکتورهای صادرشده در این بخش نمایش داده می‌شوند.' : 'پس از ثبت واریز، وضعیت درخواست اینجا نمایش داده می‌شود.'}
          />
        ) : (
          <Table headers={isInvoice ? ['شماره', 'شرح', 'مبلغ', 'تاریخ', 'وضعیت'] : ['شماره', 'فاکتور', 'مبلغ', 'تاریخ', 'وضعیت']}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.number}</td>
                <td>{isInvoice ? row.description : row.invoiceNumber ?? '—'}</td>
                <td>{formatToman(row.amount)}</td>
                <td>{row.date}</td>
                <td><Badge>{row.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
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
