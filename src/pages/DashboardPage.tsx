import {
  Box,
  FileText,
  Globe2,
  HardDrive,
  LifeBuoy,
  Network,
  Plus,
  Settings,
  WalletCards,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { EmptyState } from '../components/ui/States'
import { MetricCard, type Accent } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'

const metrics: Array<{ label: string; value: string; icon: typeof HardDrive; accent: Accent; path: string }> = [
  { label: 'سرور فعال', value: '۰', icon: HardDrive, accent: 'blue', path: '/servers' },
  { label: 'آی‌پی', value: '۰', icon: Globe2, accent: 'amber', path: '/ips' },
  { label: 'دامنه', value: '۰', icon: Network, accent: 'cyan', path: '/domains' },
  { label: 'بسته ترافیک', value: '۰', icon: Box, accent: 'green', path: '/traffic-packages' },
  { label: 'تیکت باز', value: '۰', icon: LifeBuoy, accent: 'purple', path: '/tickets' },
  { label: 'فاکتور پرداخت‌نشده', value: '۰', icon: FileText, accent: 'red', path: '/invoices' },
]

const quickLinks = [
  { label: 'ایجاد سرور', icon: HardDrive, path: '/servers/create', accent: 'blue' },
  { label: 'ثبت دامنه', icon: Network, path: '/domains/register', accent: 'purple' },
  { label: 'کیف پول', icon: WalletCards, path: '/wallet', accent: 'green' },
  { label: 'فاکتورها', icon: FileText, path: '/invoices', accent: 'red' },
  { label: 'تیکت پشتیبانی', icon: LifeBuoy, path: '/tickets', accent: 'cyan' },
  { label: 'تنظیمات', icon: Settings, path: '/settings', accent: 'amber' },
]

export function DashboardPage() {
  return (
    <div className="page-stack">
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
            <MetricCard {...metric} />
          </Link>
        ))}
      </div>

      <div className="dashboard-grid">
        <Card className="dashboard-servers">
          <SectionHeading title="سرورهای اخیر" icon={<HardDrive size={20} />} action={<Link to="/servers" className="text-link">مشاهده همه</Link>} />
          <EmptyState
            compact
            icon={HardDrive}
            title="هنوز سروری نساخته‌اید"
            description="سرورهای اخیر شما پس از ایجاد در این بخش نمایش داده می‌شوند."
            action={<LinkButton to="/servers/create" size="sm" icon={<Plus size={16} />}>ساخت اولین سرور</LinkButton>}
          />
        </Card>

        <Card className="wallet-overview">
          <SectionHeading title="موجودی کیف پول" icon={<WalletCards size={20} />} />
          <div className="wallet-balance"><strong>۰ تومان</strong><span>مجموع موجودی کیف پول‌های شما</span></div>
          <Link to="/wallet" className="card-link">برای شارژ کلیک کنید</Link>
        </Card>

        <Card className="recent-tickets">
          <SectionHeading title="تیکت‌های اخیر" icon={<LifeBuoy size={20} />} action={<Link to="/tickets" className="text-link">مشاهده همه</Link>} />
          <EmptyState compact icon={LifeBuoy} title="تیکتی ثبت نشده است" />
        </Card>
      </div>

      <Card>
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
