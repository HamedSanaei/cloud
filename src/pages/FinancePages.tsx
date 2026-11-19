import {
  ArrowDownToLine,
  CircleDollarSign,
  CreditCard,
  Download,
  FileText,
  Plus,
  WalletCards,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useApiQuery } from '../hooks/useApiQuery'
import { ApiError } from '../lib/apiClient'
import { getWalletSummary, listChargeRequests, listInvoices, listTransactions } from '../lib/endpoints'
import { formatCount, formatFaDateTime, formatToman, toAsciiDigits } from '../lib/format'
import type { Invoice } from '../lib/types'
import { WalletRecharge } from '../components/ui/WalletRecharge'
import { WalletPaymentStatus } from '../components/ui/WalletPaymentStatus'
import { useAuth } from '../auth/AuthContext'
import { WalletLedgerAmountCells, WalletLedgerDescription } from '../components/ui/WalletLedgerCells'
import { emptyAmount, movementAmounts, movementHeaders, transactionsCsv, transactionStatus } from '../lib/walletHistory'
import { chargeReferences } from '../lib/paymentHandoff'

const walletHistoryHeaders = ['شرح', 'کیف پول', ...movementHeaders, 'تاریخ', 'وضعیت']

function FinancialDate({ date, dueAt, paidAt, timezone, label }: { date: string; dueAt?: string; paidAt?: string; timezone?: string; label?: string }) {
  return <>{label && `${label}: `}<time dateTime={date}>{formatFaDateTime(date, timezone)}</time>{dueAt && dueAt !== date && <small style={{ display: 'block' }}>سررسید: <time dateTime={dueAt}>{formatFaDateTime(dueAt, timezone)}</time></small>}{paidAt && <small style={{ display: 'block' }}>ثبت پرداخت: <time dateTime={paidAt}>{formatFaDateTime(paidAt, timezone)}</time></small>}</>
}

export function WalletPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const returnToCheckout = searchParams.get('returnTo') === 'server-checkout'
  const chargeId = searchParams.get('charge')
  const receiptId = chargeId ?? searchParams.get('payment')
  const [period, setPeriod] = useState<'24h' | '7d'>('24h')
  const [page, setPage] = useState(0)

  const summary = useApiQuery(getWalletSummary)
  const transactions = useApiQuery(async () => ({ period, ...await listTransactions(period) }), [period])
  const refreshSummary = summary.refetch, refreshTransactions = transactions.refetch
  useEffect(() => {
    const refresh = () => { refreshSummary(); refreshTransactions() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refreshSummary, refreshTransactions])

  const summaryData = summary.data
  const rows = transactions.data?.period === period ? transactions.data.rows : []
  const partial = transactions.data?.period === period && !transactions.data.complete
  const pageSize = 50, pageCount = Math.ceil(rows.length / pageSize)
  const currentPage = Math.min(page, Math.max(0, pageCount - 1))
  const visibleTransactions = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const downloadTransactions = () => {
    const url = URL.createObjectURL(new Blob([transactionsCsv(rows, user?.timezone)], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'wallet-transactions.csv'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="page-stack wallet-page">
      <PageHeader title="کیف پول 💰" subtitle="موجودی و گردش حساب" icon={<WalletCards />} actions={<WalletRecharge />} />
      {returnToCheckout ? <div className="info-box checkout-return"><span>انتخاب‌های سرور شما برای بازگشت از شارژ نگه داشته شده‌اند.</span><LinkButton to="/servers/create" variant="secondary">بازگشت به سفارش سرور</LinkButton></div> : null}
      {receiptId ? <WalletPaymentStatus key={receiptId} id={receiptId} byCharge={!!chargeId}
        onVerified={() => { summary.refetch(); transactions.refetch() }} /> : null}
      {summary.error && <QueryError message={summary.error} onRetry={summary.refetch} />}
      <MetricCard label="موجودی کل" value={summary.loading ? '...' : summary.error ? 'دریافت نشد' : formatToman(summaryData?.totalBalance ?? 0)} icon={CircleDollarSign} accent="green" />

      <Card className="wallet-transactions">
        <SectionHeading title="تراکنش‌ها" action={<Button variant="secondary" size="sm" icon={<Download size={16} />} disabled={!rows.length || partial || transactions.loading || !!transactions.error} onClick={downloadTransactions}>دانلود</Button>} />
        <div className="segmented-filter">
          <button type="button" aria-pressed={period === '24h'} className={period === '24h' ? 'active' : ''} onClick={() => { setPeriod('24h'); setPage(0) }}>۲۴ ساعت اخیر</button>
          <button type="button" aria-pressed={period === '7d'} className={period === '7d' ? 'active' : ''} onClick={() => { setPeriod('7d'); setPage(0) }}>۷ روز اخیر</button>
        </div>
        {partial && !transactions.loading && !transactions.error && <p role="status">سرویس مشترک فقط ۵۰ تراکنش آخر را ارائه می‌دهد. دانلود برای بازهٔ ناقص در دسترس نیست.</p>}
        {transactions.loading ? (
          <LoadingState label="در حال دریافت تراکنش‌ها..." />
        ) : transactions.error ? (
          <QueryError message={transactions.error} onRetry={transactions.refetch} />
        ) : !visibleTransactions.length ? (
          <Table headers={walletHistoryHeaders}>
            <tr className="table-empty"><td colSpan={walletHistoryHeaders.length}>هیچ تراکنشی یافت نشد</td></tr>
          </Table>
        ) : (
          <Table headers={walletHistoryHeaders}>
            {visibleTransactions.map((transaction) => (
              <tr key={transaction.id}>
                <td><WalletLedgerDescription transaction={transaction} /></td>
                <td>{transaction.wallet || emptyAmount}</td>
                <WalletLedgerAmountCells amounts={movementAmounts(transaction)} />
                <td><FinancialDate label="ثبت تراکنش" date={transaction.date} dueAt={transaction.scheduledAt} timezone={user?.timezone} /></td>
                <td><Badge>{transactionStatus(transaction.status)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
        {!transactions.loading && !transactions.error && pageCount > 1 && <div className="segmented-filter" aria-label="صفحه‌بندی تراکنش‌ها" role="group">
          <Button variant="secondary" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>صفحهٔ قبل</Button>
          <span aria-live="polite">صفحهٔ {formatCount(currentPage + 1)} از {formatCount(pageCount)} · {formatCount(rows.length)} تراکنش</span>
          <Button variant="secondary" size="sm" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>صفحهٔ بعد</Button>
        </div>}
      </Card>
    </div>
  )
}

interface FinancialListProps {
  type: 'invoice' | 'charge'
}

const invoiceStatusLabels: Record<string, string> = { pending: 'در انتظار پرداخت', paid: 'پرداخت شده', cancelled: 'لغو شده', refunded: 'مسترد شده' }
const invoicePeriods: Record<string, string> = { HOURLY: 'ساعتی', DAILY: 'روزانه', MONTHLY: 'ماهانه' }
const invoiceDescription = (text = '') => text.replace(/^(تمدید .*?[-—–]\s*)(HOURLY|DAILY|MONTHLY)\s*$/, (_match, prefix, period) => prefix + invoicePeriods[period])
const chargeStatusLabels: Record<string, string> = {
  pending: 'در انتظار', approved: 'تایید شده', rejected: 'رد شده', processing: 'در حال پردازش',
}

function FinancialList({ type }: FinancialListProps) {
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const isInvoice = type === 'invoice'
  const Icon = isInvoice ? FileText : CreditCard

  const active = useApiQuery(async () => {
    try { return { items: isInvoice ? await listInvoices() : await listChargeRequests(), unavailable: '' } }
    catch (error) {
      if (isInvoice && error instanceof ApiError && error.status === 501) return { items: [], unavailable: error.message }
      throw error
    }
  }, [type])

  const rows = useMemo(() => {
    const items = (active.data?.items ?? []) as Array<Partial<Pick<Invoice, 'description' | 'traffic' | 'dueAt' | 'paidAt'>> & {
      number: string; invoiceNumber?: string; paymentReference?: string; status: string; amount: number; formattedAmount?: string; date: string; id: string
    }>
    const normalized = toAsciiDigits(query.trim())
    return items.filter((item) => {
      const haystack = toAsciiDigits(`${item.number} ${item.description ?? ''} ${item.invoiceNumber ?? ''} ${item.paymentReference ?? ''} ${isInvoice ? invoiceDescription(item.description) : ''}`)
      const matchesQuery = !normalized || haystack.includes(normalized)
      const matchesStatus = status === 'all' || item.status === status
      return matchesQuery && matchesStatus
    })
  }, [active.data, query, status, isInvoice])

  return (
    <div className="page-stack financial-list-page">
      <PageHeader
        title={isInvoice ? 'فاکتورها 📄' : 'درخواست‌های شارژ 💳'}
        subtitle={isInvoice ? 'مشاهده و مدیریت فاکتورهای شما' : 'مشاهده وضعیت آخرین درخواست‌های واریز به کیف پول (حداکثر ۵۰ مورد در سرویس مشترک)'}
        icon={<Icon />}
      />
      <FilterPanel
        query={query}
        onQueryChange={setQuery}
        placeholder={isInvoice ? 'جستجو در شماره فاکتور یا توضیحات...' : 'جستجو در شماره درخواست، پیگیری پرداخت یا فاکتور...'}
        onReset={() => { setQuery(''); setStatus('all') }}
      >
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="وضعیت">
          <option value="all">همه وضعیت‌ها</option>
          {Object.entries(isInvoice ? invoiceStatusLabels : chargeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </FilterPanel>
      <Card className={!active.loading && !active.error && !active.data?.unavailable && !rows.length ? 'resource-empty-card' : undefined}>
        <SectionHeading title={isInvoice ? 'لیست فاکتورها' : 'لیست درخواست‌ها'} />
        {active.loading ? (
          <LoadingState label="در حال دریافت..." />
        ) : active.error ? (
          <QueryError message={active.error} onRetry={active.refetch} />
        ) : active.data?.unavailable ? (
          <EmptyState icon={FileText} title="فاکتور رسمی در سرویس مرجع ارائه نشده است" description={active.data.unavailable} action={<><LinkButton to="/charge-requests" variant="secondary">سوابق پرداخت</LinkButton><LinkButton to="/wallet" variant="secondary">گردش حساب کیف پول</LinkButton></>} />
        ) : !rows.length ? (
          <EmptyState
            icon={isInvoice ? FileText : ArrowDownToLine}
            title={isInvoice ? 'فاکتوری یافت نشد' : 'درخواست شارژی یافت نشد'}
            description={query || status !== 'all' ? 'فیلتر یا عبارت جستجو را تغییر دهید.' : isInvoice ? 'فاکتورهای صادرشده در این بخش نمایش داده می‌شوند.' : 'پس از ثبت واریز، وضعیت درخواست اینجا نمایش داده می‌شود.'}
            action={isInvoice ? <LinkButton to="/dashboard">بازگشت به داشبورد</LinkButton> : <LinkButton to="/wallet" icon={<Plus size={18} />}>شارژ کیف پول</LinkButton>}
          />
        ) : (
          <Table headers={isInvoice ? ['شماره', 'شرح', 'مبلغ', 'تاریخ', 'وضعیت'] : ['شماره', 'شماره پیگیری پرداخت', 'فاکتور', 'مبلغ', 'تاریخ', 'وضعیت', 'پیگیری']}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.number}</td>
                <td>{isInvoice ? <>{invoiceDescription(row.description)}{row.traffic?.length ? <details>
                  <summary>جزئیات ترافیک مازاد</summary>
                  <ul>{row.traffic.map(line => <li key={line.month}>
                    <bdi>{line.month}</bdi> · {formatCount(line.blocks)} بلوک ۱۰۰ مگابایتی · {formatCount(line.totalRial)} ریال (مالیات {formatCount(line.taxRial)} ریال)
                    <br />مصرف قبلی {formatCount(line.previousOutgoingBytes)}، مصرف فعلی {formatCount(line.outgoingBytes)}، سهمیه {formatCount(line.includedBytes)} بایت
                    <br />هر یورو {formatCount(Number(line.fxRate))} ریال · {formatFaDateTime(line.fxAt, user?.timezone)}
                  </li>)}</ul>
                </details> : null}</> : chargeReferences(row).paymentReference ?? '—'}</td>
                {!isInvoice && <td>{chargeReferences(row).invoiceNumber ?? '—'}</td>}
                <td>{row.formattedAmount ?? formatToman(row.amount)}</td>
                <td><FinancialDate label={isInvoice ? 'صدور' : undefined} date={row.date} dueAt={isInvoice ? row.dueAt : undefined} paidAt={isInvoice ? row.paidAt : undefined} timezone={user?.timezone} /></td>
                <td><Badge>{(isInvoice ? invoiceStatusLabels : chargeStatusLabels)[row.status] ?? 'نامشخص'}</Badge></td>
                {!isInvoice && <td><LinkButton to={`/wallet?charge=${encodeURIComponent(row.id)}`} variant="secondary">پیگیری درخواست</LinkButton></td>}
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
