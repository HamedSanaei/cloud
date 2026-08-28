import {
  Box,
  Globe2,
  HardDrive,
  Network,
  Plus,
  RefreshCw,
  ServerCog,
} from 'lucide-react'
import { useState } from 'react'
import { Button, LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState } from '../components/ui/States'
import { useToast } from '../components/ui/Toast'

type ResourceKind = 'server' | 'ip'

function ResourceList({ kind }: { kind: ResourceKind }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [secondary, setSecondary] = useState('all')
  const { showToast } = useToast()
  const server = kind === 'server'

  return (
    <div className="page-stack">
      <PageHeader
        title={server ? 'مدیریت سرورها' : 'مدیریت آی‌پی‌ها'}
        subtitle={server ? 'سرورهای خود را مدیریت کنید و سرورهای جدید ایجاد کنید.' : 'لیست تمام آی‌پی‌های شما و سرورهای متصل به آن‌ها'}
        icon={server ? <HardDrive /> : <Globe2 />}
        actions={
          <>
            {server ? <LinkButton to="/servers/create" icon={<Plus size={18} />}>ایجاد سرور جدید</LinkButton> : <Button icon={<Plus size={18} />} onClick={() => showToast('درخواست خرید آی‌پی ثبت آزمایشی شد.')}>خرید آی‌پی</Button>}
            {!server ? <Button variant="secondary" icon={<RefreshCw size={17} />} onClick={() => showToast('فهرست آی‌پی‌ها بروزرسانی شد.')}>بروزرسانی</Button> : null}
          </>
        }
      />
      <FilterPanel query={query} onQueryChange={setQuery} placeholder={server ? 'جستجو در سرورها...' : 'جستجو در آی‌پی، سرور یا دیتاسنتر...'} onReset={() => { setQuery(''); setStatus('all'); setSecondary('all') }}>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="وضعیت"><option value="all">همه وضعیت‌ها</option><option>غیرفعال</option><option>فعال</option>{!server ? <option>رزرو شده</option> : null}</Select>
        <Select value={secondary} onChange={(event) => setSecondary(event.target.value)} aria-label={server ? 'دیتاسنتر' : 'نوع آی‌پی'}>
          <option value="all">{server ? 'همه دیتاسنترها' : 'همه انواع'}</option>
          {server ? <><option>تهران</option><option>آلمان</option></> : <><option>IPv4</option><option>IPv6</option></>}
        </Select>
      </FilterPanel>
      <Card>
        <SectionHeading title={server ? 'لیست سرورها' : 'لیست آی‌پی‌ها'} />
        <EmptyState
          icon={server ? ServerCog : Globe2}
          title={server ? 'هنوز سروری نساخته‌اید' : 'آی‌پی‌ای یافت نشد'}
          description={query ? 'عبارت جستجو یا فیلترها را تغییر دهید.' : server ? 'برای شروع، اولین سرور ابری خود را ایجاد کنید.' : 'آی‌پی‌های خریداری‌شده و وضعیت اتصال آن‌ها اینجا نمایش داده می‌شود.'}
          action={server ? <LinkButton to="/servers/create" icon={<Plus size={17} />}>ساخت اولین سرور</LinkButton> : <Button icon={<Plus size={17} />} onClick={() => showToast('درخواست خرید آی‌پی ثبت آزمایشی شد.')}>خرید آی‌پی</Button>}
        />
      </Card>
    </div>
  )
}

export function ServersPage() {
  return <ResourceList kind="server" />
}

export function IpsPage() {
  return <ResourceList kind="ip" />
}

export function TrafficPackagesPage() {
  const { showToast } = useToast()
  return (
    <div className="page-stack">
      <PageHeader title="بسته ترافیک 📦" subtitle="مدیریت بسته‌های ترافیک و سرورهای متصل" icon={<Box />} actions={<Button icon={<Plus size={18} />} onClick={() => showToast('فرآیند خرید بسته ترافیک در حالت نمایشی است.')}>خرید بسته ترافیک</Button>} />
      <div className="metrics-grid metrics-grid--four">
        <MetricCard label="بسته ترافیک فعال" value="۰" icon={Box} />
        <MetricCard label="سرور متصل‌شده" value="۰" icon={HardDrive} accent="cyan" />
        <MetricCard label="سرور بدون پکیج" value="۰" icon={ServerCog} accent="amber" />
        <MetricCard label="دانلود / آپلود" value="↓ ۰  ↑ ۰" icon={RefreshCw} accent="green" />
      </div>
      <Card>
        <SectionHeading title="پکیج‌ها" />
        <EmptyState icon={Box} title="هیچ بسته ترافیکی یافت نشد" description="بسته‌های ترافیک خریداری‌شده در اینجا نمایش داده می‌شوند." action={<Button icon={<Plus size={17} />} onClick={() => showToast('فرآیند خرید بسته ترافیک در حالت نمایشی است.')}>خرید بسته ترافیک</Button>} />
      </Card>
    </div>
  )
}

export function DomainsPage() {
  const [tab, setTab] = useState<'domains' | 'orders'>('domains')
  const { showToast } = useToast()

  return (
    <div className="page-stack">
      <PageHeader
        title="مدیریت دامنه‌ها"
        subtitle="لیست دامنه‌ها و سفارش‌های در انتظار شما"
        icon={<Network />}
        actions={
          <>
            <LinkButton to="/domains/register" icon={<Plus size={18} />}>ثبت دامنه</LinkButton>
            <Button variant="secondary" onClick={() => showToast('فرآیند انتقال دامنه در حالت نمایشی است.')}>انتقال دامنه</Button>
            <Button variant="ghost" icon={<RefreshCw size={17} />} onClick={() => showToast('فهرست دامنه‌ها بروزرسانی شد.')}>بروزرسانی</Button>
          </>
        }
      />
      <Card>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'domains'} className={tab === 'domains' ? 'active' : ''} onClick={() => setTab('domains')}>دامنه‌ها</button>
          <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>سفارش‌های در انتظار</button>
        </div>
        <EmptyState
          icon={Network}
          title={tab === 'domains' ? 'دامنه‌ای یافت نشد' : 'سفارش در انتظاری وجود ندارد'}
          description={tab === 'domains' ? 'دامنه‌های ثبت‌شده و وضعیت تمدید آن‌ها اینجا نمایش داده می‌شوند.' : 'سفارش‌های در حال پردازش در این بخش نمایش داده می‌شوند.'}
          action={tab === 'domains' ? <LinkButton to="/domains/register" icon={<Plus size={17} />}>ثبت دامنه جدید</LinkButton> : undefined}
        />
      </Card>
    </div>
  )
}
