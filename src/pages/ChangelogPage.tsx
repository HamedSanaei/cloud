import { BellRing, Box, LayoutDashboard, Network, Sparkles } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Badge } from '../components/ui/Table'

const releases = [
  {
    version: 'v1.0.0',
    title: 'راه‌اندازی نسخه اولیه کنسول',
    date: 'امروز',
    icon: Sparkles,
    changes: ['داشبورد یکپارچه مدیریت سرویس‌ها', 'کیف پول و فاکتورهای مالی', 'مدیریت سرورها، آی‌پی و دامنه‌ها'],
  },
  {
    version: 'تجربه کاربری',
    title: 'بهبود ناوبری و حالت‌های خالی',
    date: 'نسخه طراحی',
    icon: LayoutDashboard,
    changes: ['فیلترهای مشترک و قابل استفاده مجدد', 'حالت تاریک و طراحی واکنش‌گرا', 'جستجوی سراسری منوها'],
  },
  {
    version: 'زیرساخت',
    title: 'ابزارهای مدیریت منابع',
    date: 'نسخه طراحی',
    icon: Network,
    changes: ['ویزارد ایجاد سرور', 'فرآیند ثبت دامنه', 'بسته ترافیک و مدیریت IP'],
  },
]

export function ChangelogPage() {
  return (
    <div className="page-stack">
      <PageHeader title="تغییرات 📢" subtitle="آخرین بروزرسانی‌ها و اطلاع‌رسانی‌ها" icon={<BellRing />} />
      <Card className="timeline-card">
        <div className="timeline">
          {releases.map(({ version, title, date, icon: Icon, changes }) => (
            <article className="timeline__item" key={version}>
              <span className="timeline__marker"><Icon size={20} /></span>
              <div className="timeline__content">
                <div className="timeline__meta"><Badge tone="info">{version}</Badge><span>{date}</span></div>
                <h2>{title}</h2>
                <ul>{changes.map((change) => <li key={change}><Box size={15} />{change}</li>)}</ul>
              </div>
            </article>
          ))}
        </div>
      </Card>
    </div>
  )
}
