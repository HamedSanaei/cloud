import {
  Box,
  FileText,
  Globe2,
  HardDrive,
  LifeBuoy,
  Network,
  Plus,
  WalletCards,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { useApiQuery } from '../hooks/useApiQuery'
import { getDashboardSummary, getRecentServers, getRecentTickets } from '../lib/endpoints'
import { formatCount, formatToman } from '../lib/format'

const quickLinks = [
  { label: 'ایجاد سرور', icon: HardDrive, path: '/servers/create', accent: 'blue' },
  { label: 'ثبت دامنه', icon: Network, path: '/domains/register', accent: 'purple' },
  { label: 'کیف پول', icon: WalletCards, path: '/wallet', accent: 'green' },
  { label: 'فاکتورها', icon: FileText, path: '/invoices', accent: 'red' },
  { label: 'تیکت پشتیبانی', icon: LifeBuoy, path: '/tickets', accent: 'cyan' },
]

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'active' || status === 'answered') return 'success'
  if (status === 'building' || status === 'pending' || status === 'review') return 'warning'
  return 'neutral'
}

export function DashboardPage() {
  const summary = useApiQuery(getDashboardSummary)
  const servers = useApiQuery(getRecentServers)
  const tickets = useApiQuery(getRecentTickets)

  const data = summary.data
  const metrics = [
    { label: 'سرور فعال', value: formatCount(data?.activeServers ?? 0), icon: HardDrive, accent: 'blue' as const, path: '/servers' },
    { label: 'آی‌پی', value: formatCount(data?.ips ?? 0), icon: Globe2, accent: 'amber' as const, path: '/ips' },
    { label: 'دامنه', value: formatCount(data?.domains ?? 0), icon: Network, accent: 'cyan' as const, path: '/domains' },
    { label: 'بسته ترافیک', value: formatCount(data?.trafficPackages ?? 0), icon: Box, accent: 'green' as const, path: '/traffic-packages' },
    { label: 'تیکت باز', value: formatCount(data?.openTickets ?? 0), icon: LifeBuoy, accent: 'purple' as const, path: '/tickets' },
    { label: 'فاکتور پرداخت‌نشده', value: formatCount(data?.unpaidInvoices ?? 0), icon: FileText, accent: 'red' as const, path: '/invoices' },
  ]

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        title="خوش آمدید 👋"
        subtitle="از اینجا می‌توانید سرویس‌های خود را مدیریت کنید."
        actions={
          <>
            <LinkButton to="/servers/create" icon={<Plus size={18} />}>ایجاد سرور جدید</LinkButton>
            <LinkButton to="/wallet" variant="success" icon={<WalletCards size={18} />}>شارژ کیف پول</LinkButton>
          </>
        }
      />

      <div className="metrics-grid metrics-grid--six">
        {metrics.map((metric) => (
          <Link to={metric.path} key={metric.label} className="metric-link">
            <MetricCard {...metric} value={summary.loading ? '…' : summary.error ? '—' : metric.value} />
          </Link>
        ))}
      </div>

      <div className="dashboard-grid">
        <Card className="dashboard-servers">
          <SectionHeading title="سرورهای اخیر" icon={<HardDrive size={20} />} action={<Link to="/servers" className="text-link">مشاهده همه</Link>} />
          {servers.loading ? (
            <LoadingState label="در حال دریافت سرورها..." />
          ) : servers.error ? (
            <QueryError message={servers.error} onRetry={servers.refetch} />
          ) : !servers.data?.length ? (
            <EmptyState
              compact
              icon={HardDrive}
              title="هنوز سروری نساخته‌اید"
              description="سرورهای اخیر شما پس از ایجاد در این بخش نمایش داده می‌شوند."
              action={<LinkButton to="/servers/create" size="sm" icon={<Plus size={16} />}>ساخت اولین سرور</LinkButton>}
            />
          ) : (
            <Table headers={['نام', 'وضعیت', 'دیتاسنتر']}>
              {servers.data.map((server) => (
                <tr key={server.id}>
                  <td>{server.name}</td>
                  <td><Badge tone={statusTone(server.status)}>{server.status}</Badge></td>
                  <td>{server.datacenter}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card className="wallet-overview">
          <SectionHeading title="موجودی کیف پول" icon={<WalletCards size={20} />} />
          {summary.loading ? (
            <LoadingState label="در حال دریافت موجودی..." />
          ) : summary.error ? (
            <QueryError message={summary.error} onRetry={summary.refetch} />
          ) : (
            <>
              <div className="wallet-balance"><strong>{formatToman(data?.walletBalance ?? 0)}</strong></div>
              <Link to="/wallet" className="card-link">برای شارژ کلیک کنید</Link>
            </>
          )}
        </Card>

        <Card className="recent-tickets">
          <SectionHeading title="تیکت‌های اخیر" icon={<LifeBuoy size={20} />} action={<Link to="/tickets" className="text-link">مشاهده همه</Link>} />
          {tickets.loading ? (
            <LoadingState label="در حال دریافت تیکت‌ها..." />
          ) : tickets.error ? (
            <QueryError message={tickets.error} onRetry={tickets.refetch} />
          ) : !tickets.data?.length ? (
            <EmptyState compact icon={LifeBuoy} title="تیکتی ثبت نشده است" />
          ) : (
            <Table headers={['عنوان', 'وضعیت']}>
              {tickets.data.map((ticket) => (
                <tr key={ticket.id}>
                  <td>{ticket.title}</td>
                  <td><Badge tone={statusTone(ticket.status)}>{ticket.status}</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card className="dashboard-quick">
        <SectionHeading title="دسترسی سریع" icon={<Zap size={20} />} />
        <div className="quick-grid">
          {quickLinks.map(({ label, icon: Icon, path, accent }) => (
            <Link to={path} key={label} className={`quick-card quick-card--${accent}`}>
              <Icon size={24} />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  )
}
