import { isActiveAdmin } from '../../backend/src/contracts/account-role'
import {
  Box,
  Globe2,
  HardDrive,
  Network,
  Plus,
  RefreshCw,
  ServerCog,
} from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
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
  getInfrastructureCapabilities,
  listDomainOrders,
  listDomains,
  listIps,
  listTrafficPackages,
  searchServerOrders,
  transferDomain,
} from '../lib/endpoints'
import { formatCount } from '../lib/format'
import { ServerManagement } from '../components/ui/ServerManagement'
import { CopyableIp } from '../components/ui/CopyableIp'
import { useAuth } from '../auth/AuthContext'
import { HetznerInventoryPanel } from '../admin/HetznerInventoryPanel'
import { getIntegrationStatus } from '../lib/platformClient'
import { useServerFleet } from '../hooks/useServerFleet'
import { ServerTableRow } from '../components/servers/ServerPrimitives'
import { serverRowKey } from '../lib/serverLifecycle'
import { normalizeSearchText } from '../../backend/src/contracts/search-text'
import { useDebouncedValue } from '../hooks/useDebouncedValue'

type ResourceKind = 'server' | 'ip'
const ipStatusLabels = { inactive: 'غیرفعال', active: 'فعال', reserved: 'رزرو شده' }

function useInfrastructurePurchase(service: 'ips' | 'trafficPackages' | null) {
  const query = useApiQuery(() => service ? getInfrastructureCapabilities() : Promise.resolve(null), [service])
  const messageId = useId()
  const capability = service ? query.data?.[service] : undefined
  const enabled = !query.loading && !query.error && capability?.enabled === true
  const name = service === 'ips' ? 'آی‌پی اختصاصی' : 'بسته ترافیک'
  const message = query.loading ? `در حال بررسی امکان خرید ${name}…`
    : query.error ? `بررسی امکان خرید ${name} ناموفق بود؛ تا تأیید وضعیت، خرید در دسترس نیست.`
      : enabled ? '' : capability?.reason || `خرید ${name} فعلاً در دسترس نیست.`
  return { enabled, message, messageId, loading: query.loading, refetch: query.refetch }
}

function PurchaseAvailability({ purchase }: { purchase: ReturnType<typeof useInfrastructurePurchase> }) {
  if (!purchase.message) return null
  return <div className="info-box infrastructure-purchase-availability"><span id={purchase.messageId} role="status">{purchase.message}</span>
    {!purchase.loading && <Button variant="secondary" size="sm" onClick={purchase.refetch}>بررسی دوبارهٔ امکان خرید</Button>}
  </div>
}

function ResourceList({ kind }: { kind: ResourceKind }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [secondary, setSecondary] = useState('all')
  const { showToast } = useToast()
  const server = kind === 'server'
  const purchase = useInfrastructurePurchase(server ? null : 'ips')
  const [buying, setBuying] = useState(false)
  const [managedId, setManagedId] = useState<string | null>(null)
  const integration = useApiQuery(getIntegrationStatus)

  const servers = useServerFleet(server)
  const ips = useApiQuery(listIps, [kind])
  const active = server ? servers : ips
  const refreshServers = servers.refetch
  const searchRef = useRef<HTMLInputElement>(null)
  const resetFilters = () => { setQuery(''); setStatus('all'); setSecondary('all'); searchRef.current?.focus() }
  const term = normalizeSearchText(query)
  const hasFilters = !!term || status !== 'all' || secondary !== 'all'
  const reference = server && /^ord-.{1,36}$/.test(term) ? term : ''
  const lookup = useDebouncedValue(reference)
  const orderSearch = useApiQuery(async () => ({ reference: lookup, rows: lookup ? await searchServerOrders(lookup) : [] }), [lookup])
  const waitingForOrderSearch = !!reference && (reference !== lookup || orderSearch.loading ||
    (orderSearch.data?.reference !== reference && !orderSearch.error))

  const filteredServers = useMemo(() => {
    if (!server) return []
    const fleet = new Map(servers.data.map(item => [serverRowKey(item), item]))
    const matchingOrders = new Set<string>()
    if (reference && orderSearch.data?.reference === reference) {
      for (const item of orderSearch.data.rows) {
        const key = serverRowKey(item)
        matchingOrders.add(key)
        if (!fleet.has(key)) fleet.set(key, item)
      }
    }
    return [...fleet.entries()].filter(([key, item]) => {
      const matchesQuery = !term || [item.name, item.datacenter, item.id, item.platformServerId, item.serverId, item.orderId,
        item.ip, item.ipv6, item.tracking?.reference, item.tracking?.serverId, item.tracking?.orderId, item.tracking?.failure?.reference]
        .some(value => value != null && normalizeSearchText(value).includes(term)) || matchingOrders.has(key)
      const matchesStatus = status === 'all' || (status === 'failed'
        ? (item.lifecycle ?? item.tracking?.state) === 'failed'
        : item.status === status)
      const matchesDatacenter = secondary === 'all' || item.datacenter === secondary
      return matchesQuery && matchesStatus && matchesDatacenter
    }).map(([, item]) => item)
  }, [server, servers.data, reference, orderSearch.data, term, status, secondary])

  const filteredIps = useMemo(() => {
    if (server) return []
    const items = (ips.data ?? []).filter((item) => {
      const haystack = normalizeSearchText(`${item.address} ${item.server ?? ''} ${item.datacenter}`)
      const matchesQuery = !term || haystack.includes(term)
      const matchesStatus = status === 'all' || item.status === status
      const matchesVersion = secondary === 'all' || item.version === secondary
      return matchesQuery && matchesStatus && matchesVersion
    })
    return items
  }, [server, ips.data, term, status, secondary])

  const handleBuyIp = async () => {
    if (!purchase.enabled || buying) return
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
    <div className={`page-stack resource-list-page${server ? ' server-list-page' : ''}`}>
      <PageHeader
        title={server ? 'مدیریت سرورها' : 'مدیریت آی‌پی‌ها'}
        subtitle={server ? 'سرورهای خود را مدیریت کنید و سرورهای جدید ایجاد کنید.' : 'نشانی‌های آی‌پی متصل به سرورهای شما'}
        icon={server ? <HardDrive /> : <Globe2 />}
        actions={
          <>
            {server ? <LinkButton to="/servers/create" icon={<Plus size={18} />}>ایجاد سرور جدید</LinkButton> : <Button icon={<Plus size={18} />} disabled={buying || !purchase.enabled} aria-describedby={purchase.message ? purchase.messageId : undefined} onClick={handleBuyIp}>{buying ? 'در حال ثبت...' : 'خرید آی‌پی'}</Button>}
            <Button variant="secondary" icon={<RefreshCw size={17} />} onClick={() => { active.refetch(); if (reference) orderSearch.refetch(); if (!server) purchase.refetch() }}>بروزرسانی</Button>
          </>
        }
      />
      {!server && <PurchaseAvailability purchase={purchase} />}
      <FilterPanel query={query} onQueryChange={setQuery} searchRef={searchRef} placeholder={server ? 'جستجو در سرورها...' : 'جستجو در آی‌پی، سرور یا دیتاسنتر...'} onReset={resetFilters}>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="وضعیت"><option value="all">همه وضعیت‌ها</option>
          {Object.entries(ipStatusLabels).filter(([value]) => !server || value !== 'reserved').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          {server && <option value="failed">خطای ساخت</option>}
        </Select>
        <Select value={secondary} onChange={(event) => setSecondary(event.target.value)} aria-label={server ? 'دیتاسنتر' : 'نوع آی‌پی'}>
          <option value="all">{server ? 'همه دیتاسنترها' : 'همه انواع'}</option>
          {server ? [...new Set((servers.data ?? []).map(item => item.datacenter))].map(name => <option key={name} value={name}>{name}</option>) : <><option value="IPv4">IPv4</option><option value="IPv6">IPv6</option></>}
        </Select>
      </FilterPanel>
      {server && servers.error && servers.data.length > 0 && <p className="server-notice" role="status">{servers.error}</p>}
      {server && servers.paused && <p className="server-notice" role="status">زمان بررسی خودکار به پایان رسید. وضعیت حل‌نشده حفظ شده است؛ برای ادامه «بروزرسانی» را بزنید.</p>}
      {reference && reference === lookup && orderSearch.error && <QueryError message={orderSearch.error} onRetry={orderSearch.refetch} />}
      <Card className={!active.loading && !active.error && (server ? filteredServers : filteredIps).length === 0 ? 'resource-empty-card' : undefined}>
        <SectionHeading title={server ? 'لیست سرورها' : 'لیست آی‌پی‌ها'} />
        {active.loading && !active.data?.length ? (
          <LoadingState label="در حال دریافت..." />
        ) : active.error && !active.data?.length ? (
          <QueryError message={active.error} onRetry={active.refetch} />
        ) : server ? (
          filteredServers.length ? (
            <Table headers={['نام سرور', 'وضعیت', 'پلن و منابع', 'آدرس‌های آی‌پی', 'مدیریت']}>
              {filteredServers.map((item) => (
                <ServerTableRow key={serverRowKey(item)} server={item} onPlatformManage={integration.data?.enabled && item.platformServerId ? () => setManagedId(item.platformServerId!) : undefined} />
              ))}
            </Table>
          ) : waitingForOrderSearch ? <LoadingState label="در حال جستجوی سوابق سفارش..." /> : reference && orderSearch.error ? null : (
            <EmptyState
              icon={ServerCog}
              title={hasFilters ? 'سروری با این جستجو یا فیلترها یافت نشد' : 'هنوز سروری نساخته‌اید'}
              description={hasFilters ? 'عبارت جستجو یا فیلترها را تغییر دهید یا آن‌ها را پاک کنید.' : 'برای شروع، اولین سرور ابری خود را ایجاد کنید.'}
              action={hasFilters
                ? <Button variant="secondary" onClick={resetFilters}>پاک کردن فیلترها</Button>
                : <LinkButton to="/servers/create" icon={<Plus size={17} />}>ساخت اولین سرور</LinkButton>}
            />
          )
        ) : filteredIps.length ? (
          <Table headers={['آی‌پی', 'نوع', 'وضعیت', 'سرور']}>
            {filteredIps.map((item) => (
              <tr key={item.id}>
                <td><CopyableIp value={item.address} /></td>
                <td><Badge tone="info">{item.version}</Badge></td>
                <td><Badge>{ipStatusLabels[item.status] ?? 'نامشخص'}</Badge></td>
                <td>{item.server ?? '—'}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState
            icon={Globe2}
            title={hasFilters ? 'آی‌پی‌ای با این جستجو یا فیلترها یافت نشد' : 'آی‌پی‌ای یافت نشد'}
            description={hasFilters ? 'عبارت جستجو یا فیلترها را تغییر دهید یا آن‌ها را پاک کنید.' : 'نشانی‌های متصل به سرورهای شما اینجا نمایش داده می‌شوند.'}
            action={hasFilters ? <Button variant="secondary" onClick={resetFilters}>پاک کردن فیلترها</Button>
              : <Button icon={<Plus size={17} />} disabled={buying || !purchase.enabled} aria-describedby={purchase.message ? purchase.messageId : undefined} onClick={handleBuyIp}>{buying ? 'در حال ثبت...' : 'خرید آی‌پی'}</Button>}
          />
        )}
      </Card>
      {managedId && <ServerManagement key={managedId} serverId={managedId} onClose={() => { setManagedId(null); refreshServers() }} />}
    </div>
  )
}

export function ServersPage() {
  const { user } = useAuth()
  return <div className="page-stack">
    <ResourceList kind="server" />
    {isActiveAdmin(user) ? <HetznerInventoryPanel /> : null}
  </div>
}

export function IpsPage() {
  return <ResourceList kind="ip" />
}

export function TrafficPackagesPage() {
  const { showToast } = useToast()
  const purchase = useInfrastructurePurchase('trafficPackages')
  const packages = useApiQuery(listTrafficPackages)
  const [buying, setBuying] = useState(false)

  const handleBuy = async () => {
    if (!purchase.enabled || buying) return
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
      <PageHeader title="بسته ترافیک 📦" subtitle="مدیریت بسته‌های ترافیک و سرورهای متصل" icon={<Box />} actions={<Button icon={<Plus size={18} />} disabled={buying || !purchase.enabled} aria-describedby={purchase.message ? purchase.messageId : undefined} onClick={handleBuy}>{buying ? 'در حال خرید...' : 'خرید بسته ترافیک'}</Button>} />
      <PurchaseAvailability purchase={purchase} />
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
          <EmptyState icon={Box} title="هیچ بسته ترافیکی یافت نشد" description="بسته‌های ترافیک خریداری‌شده در اینجا نمایش داده می‌شوند." action={<Button icon={<Plus size={17} />} disabled={buying || !purchase.enabled} aria-describedby={purchase.message ? purchase.messageId : undefined} onClick={handleBuy}>{buying ? 'در حال خرید...' : 'خرید بسته ترافیک'}</Button>} />
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
