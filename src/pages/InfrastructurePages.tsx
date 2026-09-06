import {
  Box,
  Globe2,
  HardDrive,
  Network,
  Plus,
  RefreshCw,
  ServerCog,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { FilterPanel } from '../components/ui/FilterPanel'
import { Select } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState, LoadingState, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'
import { useApiQuery } from '../hooks/useApiQuery'
import { isApiConfigured } from '../lib/apiClient'
import {
  buyIp,
  buyTrafficPackage,
  listDomainOrders,
  listDomains,
  listIps,
  listServers,
  listTrafficPackages,
  transferDomain,
} from '../lib/endpoints'
import { formatCount } from '../lib/format'

type ResourceKind = 'server' | 'ip'

function ResourceList({ kind }: { kind: ResourceKind }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [secondary, setSecondary] = useState('all')
  const { showToast } = useToast()
  const server = kind === 'server'
  const [buying, setBuying] = useState(false)

  const servers = useApiQuery(listServers, [kind])
  const ips = useApiQuery(listIps, [kind])
  const active = server ? servers : ips

  const filteredServers = useMemo(() => {
    if (!server) return []
    const items = (servers.data ?? []).filter((item) => {
      const matchesQuery = !query.trim() || item.name.includes(query.trim()) || item.datacenter.includes(query.trim())
      const matchesStatus = status === 'all' || item.status === status
      const matchesDatacenter = secondary === 'all' || item.datacenter === secondary
      return matchesQuery && matchesStatus && matchesDatacenter
    })
    return items
  }, [server, servers.data, query, status, secondary])

  const filteredIps = useMemo(() => {
    if (server) return []
    const items = (ips.data ?? []).filter((item) => {
      const haystack = `${item.address} ${item.server ?? ''} ${item.datacenter}`
      const matchesQuery = !query.trim() || haystack.includes(query.trim())
      const matchesStatus = status === 'all' || item.status === status
      const matchesVersion = secondary === 'all' || item.version === secondary
      return matchesQuery && matchesStatus && matchesVersion
    })
    return items
  }, [server, ips.data, query, status, secondary])

  const handleBuyIp = async () => {
    if (!isApiConfigured()) {
      showToast('درخواست خرید آی‌پی ثبت آزمایشی شد.')
      return
    }
    setBuying(true)
    try {
      await buyIp()
      ips.refetch()
      showToast('درخواست خرید آی‌پی ثبت شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'خرید آی‌پی ناموفق بود.')
    } finally {
      setBuying(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={server ? 'مدیریت سرورها' : 'مدیریت آی‌پی‌ها'}
        subtitle={server ? 'سرورهای خود را مدیریت کنید و سرورهای جدید ایجاد کنید.' : 'لیست تمام آی‌پی‌های شما و سرورهای متصل به آن‌ها'}
        icon={server ? <HardDrive /> : <Globe2 />}
        actions={
          <>
            {server ? <LinkButton to="/servers/create" icon={<Plus size={18} />}>ایجاد سرور جدید</LinkButton> : <Button icon={<Plus size={18} />} disabled={buying} onClick={handleBuyIp}>{buying ? 'در حال ثبت...' : 'خرید آی‌پی'}</Button>}
            {!server ? <Button variant="secondary" icon={<RefreshCw size={17} />} onClick={() => { ips.refetch(); showToast('فهرست آی‌پی‌ها بروزرسانی شد.') }}>بروزرسانی</Button> : null}
          </>
        }
      />
      <FilterPanel query={query} onQueryChange={setQuery} placeholder={server ? 'جستجو در سرورها...' : 'جستجو در آی‌پی، سرور یا دیتاسنتر...'} onReset={() => { setQuery(''); setStatus('all'); setSecondary('all') }}>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="وضعیت"><option value="all">همه وضعیت‌ها</option><option value="inactive">غیرفعال</option><option value="active">فعال</option>{!server ? <option value="reserved">رزرو شده</option> : null}</Select>
        <Select value={secondary} onChange={(event) => setSecondary(event.target.value)} aria-label={server ? 'دیتاسنتر' : 'نوع آی‌پی'}>
          <option value="all">{server ? 'همه دیتاسنترها' : 'همه انواع'}</option>
          {server ? <><option value="تهران">تهران</option><option value="آلمان">آلمان</option></> : <><option value="IPv4">IPv4</option><option value="IPv6">IPv6</option></>}
        </Select>
      </FilterPanel>
      <Card>
        <SectionHeading title={server ? 'لیست سرورها' : 'لیست آی‌پی‌ها'} />
        {active.loading ? (
          <LoadingState label="در حال دریافت..." />
        ) : active.error ? (
          <QueryError message={active.error} onRetry={active.refetch} />
        ) : server ? (
          filteredServers.length ? (
            <Table headers={['نام', 'وضعیت', 'دیتاسنتر', 'منابع']}>
              {filteredServers.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td><Badge tone={item.status === 'active' ? 'success' : 'neutral'}>{item.status}</Badge></td>
                  <td>{item.datacenter}</td>
                  <td>{[item.cpu, item.ram, item.disk].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState
              icon={ServerCog}
              title="هنوز سروری نساخته‌اید"
              description={query ? 'عبارت جستجو یا فیلترها را تغییر دهید.' : 'برای شروع، اولین سرور ابری خود را ایجاد کنید.'}
              action={<LinkButton to="/servers/create" icon={<Plus size={17} />}>ساخت اولین سرور</LinkButton>}
            />
          )
        ) : filteredIps.length ? (
          <Table headers={['آی‌پی', 'نوع', 'وضعیت', 'سرور']}>
            {filteredIps.map((item) => (
              <tr key={item.id}>
                <td style={{ direction: 'ltr' }}>{item.address}</td>
                <td><Badge tone="info">{item.version}</Badge></td>
                <td><Badge>{item.status}</Badge></td>
                <td>{item.server ?? '—'}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            icon={Globe2}
            title="آی‌پی‌ای یافت نشد"
            description={query ? 'عبارت جستجو یا فیلترها را تغییر دهید.' : 'آی‌پی‌های خریداری‌شده و وضعیت اتصال آن‌ها اینجا نمایش داده می‌شود.'}
            action={<Button icon={<Plus size={17} />} disabled={buying} onClick={handleBuyIp}>{buying ? 'در حال ثبت...' : 'خرید آی‌پی'}</Button>}
          />
        )}
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
  const packages = useApiQuery(listTrafficPackages)
  const [buying, setBuying] = useState(false)

  const handleBuy = async () => {
    if (!isApiConfigured()) {
      showToast('فرآیند خرید بسته ترافیک در حالت نمایشی است.')
      return
    }
    setBuying(true)
    try {
      await buyTrafficPackage()
      packages.refetch()
      showToast('بسته ترافیک با موفقیت خریداری شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'خرید بسته ترافیک ناموفق بود.')
    } finally {
      setBuying(false)
    }
  }

  const items = packages.data ?? []
  const activeCount = items.length
  const connectedServers = items.reduce((sum, item) => sum + item.connectedServers, 0)

  return (
    <div className="page-stack">
      <PageHeader title="بسته ترافیک 📦" subtitle="مدیریت بسته‌های ترافیک و سرورهای متصل" icon={<Box />} actions={<Button icon={<Plus size={18} />} disabled={buying} onClick={handleBuy}>{buying ? 'در حال خرید...' : 'خرید بسته ترافیک'}</Button>} />
      <div className="metrics-grid metrics-grid--four">
        <MetricCard label="بسته ترافیک فعال" value={formatCount(activeCount)} icon={Box} />
        <MetricCard label="سرور متصل‌شده" value={formatCount(connectedServers)} icon={HardDrive} accent="cyan" />
        <MetricCard label="سرور بدون پکیج" value="۰" icon={ServerCog} accent="amber" />
        <MetricCard label="دانلود / آپلود" value="↓ ۰  ↑ ۰" icon={RefreshCw} accent="green" />
      </div>
      <Card>
        <SectionHeading title="پکیج‌ها" />
        {packages.loading ? (
          <LoadingState label="در حال دریافت بسته‌ها..." />
        ) : packages.error ? (
          <QueryError message={packages.error} onRetry={packages.refetch} />
        ) : !items.length ? (
          <EmptyState icon={Box} title="هیچ بسته ترافیکی یافت نشد" description="بسته‌های ترافیک خریداری‌شده در اینجا نمایش داده می‌شوند." action={<Button icon={<Plus size={17} />} disabled={buying} onClick={handleBuy}>{buying ? 'در حال خرید...' : 'خرید بسته ترافیک'}</Button>} />
        ) : (
          <Table headers={['نام', 'سرورهای متصل', 'وضعیت']}>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{formatCount(item.connectedServers)}</td>
                <td><Badge>{item.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

export function DomainsPage() {
  const [tab, setTab] = useState<'domains' | 'orders'>('domains')
  const { showToast } = useToast()
  const domains = useApiQuery(listDomains, [tab])
  const orders = useApiQuery(listDomainOrders, [tab])
  const [transferring, setTransferring] = useState(false)

  const handleTransfer = async () => {
    if (!isApiConfigured()) {
      showToast('فرآیند انتقال دامنه در حالت نمایشی است.')
      return
    }
    const domain = window.prompt('نام دامنه برای انتقال:')
    if (!domain) return
    setTransferring(true)
    try {
      await transferDomain(domain)
      showToast('درخواست انتقال دامنه ثبت شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'انتقال دامنه ناموفق بود.')
    } finally {
      setTransferring(false)
    }
  }

  const handleRefresh = () => {
    if (tab === 'domains') domains.refetch()
    else orders.refetch()
    showToast('فهرست دامنه‌ها بروزرسانی شد.')
  }

  const domainItems = domains.data ?? []
  const orderItems = orders.data ?? []
  const loading = tab === 'domains' ? domains.loading : orders.loading
  const error = tab === 'domains' ? domains.error : orders.error
  const refetch = tab === 'domains' ? domains.refetch : orders.refetch

  return (
    <div className="page-stack">
      <PageHeader
        title="مدیریت دامنه‌ها"
        subtitle="لیست دامنه‌ها و سفارش‌های در انتظار شما"
        icon={<Network />}
        actions={
          <>
            <LinkButton to="/domains/register" icon={<Plus size={18} />}>ثبت دامنه</LinkButton>
            <Button variant="secondary" disabled={transferring} onClick={handleTransfer}>{transferring ? 'در حال ثبت...' : 'انتقال دامنه'}</Button>
            <Button variant="ghost" icon={<RefreshCw size={17} />} onClick={handleRefresh}>بروزرسانی</Button>
          </>
        }
      />
      <Card>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'domains'} className={tab === 'domains' ? 'active' : ''} onClick={() => setTab('domains')}>دامنه‌ها</button>
          <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>سفارش‌های در انتظار</button>
        </div>
        {loading ? (
          <LoadingState label="در حال دریافت..." />
        ) : error ? (
          <QueryError message={error} onRetry={refetch} />
        ) : tab === 'domains' ? (
          domainItems.length ? (
            <Table headers={['دامنه', 'وضعیت', 'انقضا']}>
              {domainItems.map((item) => (
                <tr key={item.id}>
                  <td style={{ direction: 'ltr' }}>{item.name}</td>
                  <td><Badge>{item.status}</Badge></td>
                  <td>{item.expiresAt ?? '—'}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState
              icon={Network}
              title="دامنه‌ای یافت نشد"
              description="دامنه‌های ثبت‌شده و وضعیت تمدید آن‌ها اینجا نمایش داده می‌شوند."
              action={<LinkButton to="/domains/register" icon={<Plus size={17} />}>ثبت دامنه جدید</LinkButton>}
            />
          )
        ) : orderItems.length ? (
          <Table headers={['دامنه', 'وضعیت']}>
            {orderItems.map((item) => (
              <tr key={item.id}>
                <td style={{ direction: 'ltr' }}>{item.domain}</td>
                <td><Badge tone="warning">{item.status}</Badge></td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            icon={Network}
            title="سفارش در انتظاری وجود ندارد"
            description="سفارش‌های در حال پردازش در این بخش نمایش داده می‌شوند."
          />
        )}
      </Card>
    </div>
  )
}
