import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, HardDrive, RefreshCw } from 'lucide-react'
import { Button, LinkButton } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Select } from '../components/ui/FormControls'
import { PageHeader } from '../components/ui/PageHeader'
import { LoadingState, QueryError } from '../components/ui/States'
import { useToast } from '../components/ui/Toast'
import { LifecycleBadge, ServerResourceMetricCard } from '../components/servers/ServerPrimitives'
import { DestructiveConfirmation, OneTimePassword, ServerBillingTerminationState, ServerOperationStatus, ServerPowerActionButton } from '../components/servers/ServerManagementControls'
import { ServerConsole } from '../components/servers/ServerConsole'
import { ServerAccess } from '../components/servers/ServerAccess'
import { useApiQuery } from '../hooks/useApiQuery'
import { formatFaDateTime, formatFaNumber, formatToman } from '../lib/format'
import { actionLabels, getResizeOptions, getServerDetail, getServerMetrics, previewResize, recheckServerOperation, submitServerAction,
  type ManagementAction, type ResizePreview, type ServerDetail, type ServerMetrics, type ServerOperation } from '../lib/serverManagement'

const missing = 'در دسترس نیست'
const byteValue = (value: number | null | undefined) => value === null || value === undefined ? missing : `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2 }).format(value / 1e9)} GB`
const amount = (value: number | null) => value === null ? missing : formatToman(value / 10)
const periodLabels: Record<string, string> = { HOURLY: 'ساعتی', DAILY: 'روزانه', MONTHLY: 'ماهانه' }
const tabs = [['overview', 'نمای کلی'], ['monitoring', 'مانیتورینگ'], ['operations', 'عملیات'], ['resize', 'تغییر پلن'], ['access', 'سیستم‌عامل و دسترسی'], ['console', 'کنسول و تنظیمات']] as const
type ActionRequest = { action: ManagementAction; input: Record<string, unknown> }
export function ServerDetailsPage() {
  const { id = '' } = useParams(), [search, setSearch] = useSearchParams(), tab = search.get('tab') || 'overview'
  const fresh = useRef(false)
  const detail = useApiQuery(() => {
    const refresh = fresh.current
    fresh.current = false
    return getServerDetail(id, refresh)
  }, [id]), { showToast } = useToast()
  const [request, setRequest] = useState<ActionRequest | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<{ serverId: string; operationId: string; message: string } | null>(null)
  const [secretOperation, setSecretOperation] = useState<string | null>(null), rounds = useRef(0), key = useRef('')
  const server = detail.data?.id === id ? detail.data : null, refresh = detail.refetch
  const recheck = () => { rounds.current = 0; fresh.current = true; refresh() }
  const blockingOperation = server?.operations.find(op => !['confirmed', 'failed'].includes(op.status))
  const pending = !!blockingOperation
  const checkOperation = async (operation: ServerOperation) => {
    if (checking) return
    setChecking(true)
    setChecked(null)
    try {
      const result = await recheckServerOperation(id, operation.id)
      const message = result.operation.status === 'confirmed' ? 'ارائه‌دهنده انجام عملیات را تأیید کرد.'
        : result.operation.status === 'failed' ? 'عملیات ناموفق بود. وضعیت فعلی سرور را بررسی کنید.'
          : result.checkFailed ? 'تأیید نتیجه از ارائه‌دهنده ممکن نشد. دوباره بررسی کنید یا با پشتیبانی تماس بگیرید.'
            : 'نتیجه هنوز نهایی نشده است. اگر این وضعیت ادامه داشت، با پشتیبانی تماس بگیرید.'
      setChecked({ serverId: id, operationId: operation.id, message })
    } catch {
      setChecked({ serverId: id, operationId: operation.id, message: 'بررسی عملیات ناموفق بود. دوباره تلاش کنید.' })
    } finally {
      recheck()
      setChecking(false)
    }
  }
  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden' && pending) { rounds.current = 0; refresh() } }
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume) }
  }, [pending, refresh])
  useEffect(() => {
    if (!pending || rounds.current >= 60 || detail.loading) return
    const timer = window.setTimeout(() => { if (document.visibilityState !== 'hidden') { rounds.current++; refresh() } }, Math.min(5000 * 1.3 ** rounds.current, 30000))
    return () => window.clearTimeout(timer)
  }, [pending, detail.loading, server?.operations, refresh])
  const ask = (action: ManagementAction, input: Record<string, unknown> = {}) => { key.current = crypto.randomUUID(); setError(''); setRequest({ action, input }) }
  const confirm = async () => {
    if (!request || !server || busy) return
    if (request.action === 'resize' && (pending || checking || detail.loading || detail.error || !server.capabilities.resize || !server.providerAvailable || server.resizeBlock || server.providerState !== 'suspended')) {
      setError('برای تأیید تغییر پلن، وضعیت خاموش سرور و نتیجهٔ عملیات قبلی را دوباره بررسی کنید.')
      return
    }
    setBusy(true); setError('')
    try {
      await submitServerAction(server.id, server.name, request.action, request.input, key.current)
      showToast('درخواست ثبت شد؛ نتیجهٔ نهایی ارائه‌دهنده در تاریخچه نمایش داده می‌شود.', 'info')
      setRequest(null); rounds.current = 0; refresh(); window.dispatchEvent(new Event('server-lifecycle-changed'))
    } catch (error) { setError(error instanceof Error ? error.message : 'ثبت عملیات ناموفق بود؛ پیش از تکرار، تاریخچه را بررسی کنید.') }
    finally { setBusy(false) }
  }
  if (!server) return detail.loading ? <LoadingState label="دریافت اطلاعات معتبر سرور…" /> : <QueryError message={detail.error || missing} onRetry={refresh} />
  const disabled = busy || checking || pending || !['ready', 'delete_failed'].includes(server.lifecycle) || !server.providerAvailable
  const checkingState = checking || detail.loading
  const feedback = checked?.serverId === server.id && (!blockingOperation || checked.operationId === blockingOperation.id) ? checked.message : null
  const operationRecovery = blockingOperation && <div className="server-notice server-operation-recovery">
    <p>{`تا روشن شدن نتیجهٔ «${actionLabels[blockingOperation.action] ?? 'عملیات سرور'}»، عملیات جدید امکان‌پذیر نیست.`}</p>
    <div className="server-inline-actions">
      <Button variant="secondary" size="sm" disabled={checkingState} onClick={() => void checkOperation(blockingOperation)}>{checking ? 'در حال بررسی نتیجه…' : 'بررسی نتیجهٔ عملیات'}</Button>
      {tab === 'resize' && <Button variant="secondary" size="sm" onClick={() => setSearch({ tab: 'operations' })}>مشاهدهٔ عملیات</Button>}
      {blockingOperation.status === 'outcome_unknown' && <LinkButton variant="secondary" size="sm" to="/tickets">پشتیبانی</LinkButton>}
    </div>
  </div>
  return <div className="page-stack server-detail-page" dir="rtl">
    <PageHeader title="مشخصات و مدیریت سرور" subtitle={`${server.name} · ${server.provider ?? 'ارائه‌دهنده'}`} icon={<HardDrive />}
      actions={<><LinkButton to="/servers" variant="secondary" icon={<ArrowRight size={17} />}>بازگشت به سرورها</LinkButton><Button variant="secondary" disabled={detail.loading} icon={<RefreshCw size={16} />} onClick={recheck}>بروزرسانی</Button></>} />
    <Card className="server-identity"><div><h2>{server.name}</h2><p>{[server.facts?.location || server.datacenter, server.facts?.image || server.os, server.facts?.serverType || server.serverType].filter(Boolean).join(' · ')}</p></div>
      <LifecycleBadge state={server.lifecycle} /><div><p>IPv4: <bdi>{server.facts?.ipv4 ?? missing}</bdi></p><p>IPv6: <bdi>{server.facts?.ipv6 ?? missing}</bdi></p></div>
    </Card>
    <nav className="server-detail-tabs" aria-label="مدیریت سرور">{tabs.map(([value, label]) => <button key={value} aria-current={(value === tab || value === 'console' && ['storage', 'network'].includes(tab)) ? 'page' : undefined} onClick={() => setSearch({ tab: value })}>{label}</button>)}</nav>
    {!server.providerAvailable && server.lifecycle !== 'terminated' && <p className="server-notice" role="status">اطلاعات زندهٔ ارائه‌دهنده فعلاً قابل دریافت نیست. نتیجهٔ عملیات یا مقدار مصرف حدس زده نمی‌شود.</p>}
    {detail.error && <QueryError message={detail.error} onRetry={refresh} />}
    {(tab === 'operations' || tab === 'resize') && feedback && <p className="server-notice" role="status">{feedback}</p>}
    {tab === 'overview' && <ServerOverview server={server} />}
    {tab === 'monitoring' && <ServerMonitoring server={server} />}
    {tab === 'operations' && <><Card><h2>عملیات برق سرور</h2><p className="server-notice">خاموشی نرم با خاموشی اجباری متفاوت است. خاموش‌کردن VM هزینهٔ Hetzner را متوقف نمی‌کند.</p>
      {operationRecovery}
      <p>وضعیت برق: {server.providerState === 'active' ? 'روشن' : server.providerState === 'suspended' ? 'خاموش' : missing}</p>
      <div className="server-power-grid">{(['power_on', 'shutdown', 'power_off', 'reboot', 'reset'] as const).map(action => <ServerPowerActionButton key={action} action={action} disabled={disabled || checkingState || !!detail.error || !server.capabilities.power || (action === 'power_on' ? server.providerState !== 'suspended' || server.power.billingBlocked : server.providerState !== 'active')} onClick={() => ask(action)} />)}</div>
      {server.power.billingBlocked && <p>اعتبار کیف پول برای روشن کردن کافی نیست. <LinkButton to="/wallet" variant="secondary">افزایش موجودی</LinkButton></p>}</Card>
      <Card><h2>تاریخچه عملیات</h2>{server.operations.length ? server.operations.map(operation => <ServerOperationStatus key={operation.id} operation={operation} />) : <p>هنوز عملیاتی ثبت نشده است.</p>}</Card></>}
    {tab === 'resize' && <ServerResize key={server.id} server={server} disabled={disabled || checkingState || !!detail.error}
      recovery={operationRecovery} recheck={recheck} checking={checkingState} openOperations={() => setSearch({ tab: 'operations' })} ask={ask} />}
    {tab === 'access' && <ServerAccess key={server.id} server={server} busy={busy} loading={detail.loading} stale={!!detail.error}
      ask={ask} reveal={setSecretOperation} recheck={recheck} openTab={tab => setSearch({ tab })} />}
    {tab === 'console' && <div className="server-detail-columns"><ServerConsole serverId={server.id} disabled={disabled || !server.capabilities.console} /><Card><h2>امکانات پیشرفته</h2><div className="server-advanced-links"><Button variant="secondary" onClick={() => setSearch({ tab: 'storage' })}>Snapshot، Backup و Volume</Button><Button variant="secondary" onClick={() => setSearch({ tab: 'network' })}>شبکه، حفاظت و Rescue</Button></div><p>{server.capabilities.unavailableReason}</p></Card></div>}
    {tab === 'storage' && <ServerStorage server={server} />}
    {tab === 'network' && <ServerNetwork server={server} disabled={disabled} ask={ask} />}
    {!['overview', 'monitoring', 'operations', 'resize', 'access', 'console', 'storage', 'network'].includes(tab) && <Card><p>این بخش یافت نشد.</p><Button onClick={() => setSearch({ tab: 'overview' })}>نمای کلی</Button></Card>}
    <ServerBillingTerminationState server={server} />
    <Card className="server-danger-zone"><div><h3>حذف دائمی سرور</h3><p>داده‌ها از بین می‌روند. حذف باید در ارائه‌دهنده تأیید شود.</p></div><Button variant="danger" disabled={disabled} onClick={() => ask('delete')}>حذف دائمی سرور</Button></Card>
    {request && <DestructiveConfirmation key={key.current} server={server} action={request.action} busy={busy} error={error} onClose={() => setRequest(null)} onConfirm={() => { void confirm() }} />}
    {secretOperation && <OneTimePassword server={server} operationId={secretOperation} onClose={() => { setSecretOperation(null); refresh() }} />}
  </div>
}
function ServerOverview({ server }: { server: ServerDetail }) {
  const f = server.facts, b = server.billing
  const entries = [['شناسه Hetzner / پروژه مالک', server.providerIdentity], ['نوع سرور / سیستم‌عامل', [f?.serverType, f?.image].filter(Boolean).join(' / ')], ['تاریخ ایجاد', f?.createdAt ? formatFaDateTime(f.createdAt) : missing], ['موقعیت دیتاسنتر', f?.location], ['وضعیت برق', server.providerState === 'active' ? 'روشن' : server.providerState === 'suspended' ? 'خاموش' : server.providerState === 'terminated' ? 'حذف‌شده' : missing], ['دورهٔ محاسبهٔ مصرف', f?.trafficPeriod || 'ارائه‌دهنده دورهٔ مصرف را در این پاسخ اعلام نکرده است.']]
  return <><div className="server-metric-grid"><ServerResourceMetricCard label="پردازنده" value={f?.vcpu == null ? null : `${formatFaNumber(f.vcpu)} vCPU`} /><ServerResourceMetricCard label="حافظه رم" value={f?.memoryMb == null ? null : `${formatFaNumber(f.memoryMb / 1024)} GB`} /><ServerResourceMetricCard label="دیسک" value={f?.diskGb == null ? null : `${formatFaNumber(f.diskGb)} GB`} /><ServerResourceMetricCard label="ترافیک خروجی" value={byteValue(f?.outgoingTrafficBytes)} /></div>
    <div className="server-detail-columns"><Card><h2>اطلاعات فنی</h2><dl className="server-facts">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><bdi>{value || missing}</bdi></dd></div>)}</dl></Card>
      <Card><h2>صورت‌حساب و کیف پول</h2><dl className="server-facts"><div><dt>قیمت مشتری</dt><dd>{amount(b.customerPriceRial)} / {periodLabels[b.period ?? ''] ?? missing}</dd></div><div><dt>اشتراک</dt><dd>{b.state === 'active' ? 'فعال' : b.state === 'suspended' ? 'تعلیق' : b.state === 'cancelled' ? 'پایان‌یافته' : missing}</dd></div><div><dt>تمدید بعدی</dt><dd>{b.nextInvoiceAt ? formatFaDateTime(b.nextInvoiceAt) : missing}</dd></div></dl>
        <p className="server-muted">نرخ خرید ثبت‌شدهٔ ارائه‌دهنده، جدا از قیمت مشتری: {b.providerQuotedRate ? `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 8 }).format(b.providerQuotedRate.amountCents / 100)} ${b.providerQuotedRate.currency} / ${periodLabels[b.providerQuotedRate.period] ?? b.providerQuotedRate.period}` : missing}</p>
        <p className="server-notice">خاموش‌کردن VM هزینهٔ Hetzner را متوقف نمی‌کند؛ حذف کامل و تأیید آن لازم است.</p></Card></div></>
}
function MetricChart({ title, series }: { title: string; series: ServerMetrics['series'] }) {
  const valid = Object.values(series).flat().filter((point): point is [number, number] => point[1] !== null)
  if (!valid.length) return <Card className="server-chart"><h3>{title}</h3><p>داده در دسترس نیست — مقدار صفر فرض نمی‌شود.</p></Card>
  const xs = valid.map(v => v[0]), ys = valid.map(v => v[1]), x0 = Math.min(...xs), dx = Math.max(...xs) - x0 || 1, y0 = Math.min(...ys), dy = Math.max(...ys) - y0 || 1
  return <Card className="server-chart"><h3>{title}</h3><svg role="img" aria-label={`نمودار ${title}، ${formatFaNumber(valid.length)} نمونه واقعی`} viewBox="0 0 600 160">{Object.entries(series).map(([name, values], i) => {
    const paths: string[] = []; let current = ''
    values.forEach(([time, value]) => { if (value === null) { if (current) paths.push(current); current = '' } else current += `${current ? 'L' : 'M'}${10 + (time - x0) / dx * 580},${145 - (value - y0) / dy * 130} ` })
    if (current) paths.push(current)
    return paths.map((d, n) => <path key={`${name}:${n}`} d={d} stroke={['#2869E8', '#16A34A', '#D99A00', '#9333ea'][i % 4]} fill="none" strokeWidth="2" />)
  })}</svg><p className="server-muted">کمینه: {new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 3 }).format(y0)} · بیشینه: {new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 3 }).format(Math.max(...ys))}</p><small dir="ltr">{Object.keys(series).join(' · ')}</small></Card>
}
function ServerMonitoring({ server }: { server: ServerDetail }) {
  const [window, setWindow] = useState('1h'), metrics = useApiQuery(() => getServerMetrics(server.id, window), [server.id, window])
  const group = (prefix: string, unit?: string) => Object.fromEntries(Object.entries(metrics.data?.series ?? {}).filter(([key]) => key.startsWith(prefix) && (!unit || key.includes(`.${unit === 'bytes' ? 'bandwidth' : unit}.`))))
  return <><div className="server-window-filter"><Select label="بازهٔ زمانی" value={window} onChange={event => setWindow(event.target.value)}><option value="1h">یک ساعت</option><option value="6h">شش ساعت</option><option value="24h">۲۴ ساعت</option></Select><Button variant="secondary" disabled={metrics.loading} onClick={metrics.refetch}>دریافت مجدد</Button></div>
    {metrics.loading ? <LoadingState label="دریافت دادهٔ مانیتورینگ…" /> : metrics.error ? <QueryError message={metrics.error} onRetry={metrics.refetch} /> : <div className="server-chart-grid"><MetricChart title="CPU (%)" series={group('cpu')} /><MetricChart title="Network (bytes/s)" series={group('network.', 'bytes')} /><MetricChart title="Network (packets/s)" series={group('network.', 'pps')} /><MetricChart title="Disk I/O (bytes/s)" series={group('disk.', 'bandwidth')} /><MetricChart title="Disk I/O (operations/s)" series={group('disk.', 'iops')} /><Card><h3>سهمیهٔ ترافیک</h3><p>مصرف خروجی: {byteValue(server.facts?.outgoingTrafficBytes)}</p><p>سهمیهٔ اعلام‌شده: {byteValue(server.facts?.includedTrafficBytes)}</p><p className="server-muted">{server.facts?.trafficPeriod || 'دورهٔ مصرف از API ارائه نشده است.'}</p></Card></div>}
  </>
}
function ServerResize({ server, disabled, recovery, checking, recheck, openOperations, ask }: {
  server: ServerDetail; disabled: boolean; recovery: ReactNode; checking: boolean; recheck: () => void; openOperations: () => void
  ask: (action: ManagementAction, input: Record<string, unknown>) => void
}) {
  const verifiedOff = !recovery && !server.resizeBlock && server.providerAvailable && server.capabilities.resize && server.providerState === 'suspended'
  if (!verifiedOff) {
    if (recovery) return <>{recovery}</>
    const canShutDown = !disabled && !server.resizeBlock && server.capabilities.power && server.capabilities.resize && server.providerState === 'active'
    const reason = server.resizeBlock === 'server_deleted' ? 'این سرور حذف شده است.'
      : server.resizeBlock === 'deletion_pending' ? 'درخواست حذف سرور هنوز در حال پیگیری است.'
        : server.resizeBlock === 'server_not_ready' ? 'سرور هنوز آمادهٔ مدیریت نیست.'
          : server.resizeBlock === 'provider_access_denied' ? 'دسترسی به سرور در پروژهٔ ارائه‌دهنده تأیید نشد.'
            : !server.capabilities.resize ? 'تغییر پلن برای این سرور پشتیبانی نمی‌شود.'
              : 'برای تغییر پلن، خاموش بودن سرور باید توسط ارائه‌دهنده تأیید شود.'
    return <div className="server-notice server-operation-recovery">
      <p>{canShutDown ? 'سرور روشن است. برای تغییر پلن، از بخش عملیات درخواست خاموشی بدهید.' : reason}</p>
      {canShutDown ? <Button variant="secondary" size="sm" onClick={openOperations}>رفتن به عملیات برق</Button>
        : server.resizeBlock !== 'server_deleted' && server.capabilities.resize && <Button variant="secondary" size="sm" disabled={checking} onClick={recheck}>بررسی دوبارهٔ وضعیت</Button>}
    </div>
  }
  return <ResizeForm key={`${server.id}:${server.facts?.serverType}:${server.facts?.diskGb}`} server={server} disabled={disabled} ask={ask} />
}
function ResizeForm({ server, disabled, ask }: { server: ServerDetail; disabled: boolean; ask: (action: ManagementAction, input: Record<string, unknown>) => void }) {
  const options = useApiQuery(() => getResizeOptions(server.id), [server.id])
  const [selected, setSelected] = useState(''), [upgradeDisk, setUpgradeDisk] = useState(false)
  const [preview, setPreview] = useState<ResizePreview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const eligible = (options.data ?? []).filter(option => option.available && option.type !== server.facts?.serverType)
  const selectionValid = !options.loading && !options.error && eligible.some(option => option.offerId === selected)
  const estimate = async () => {
    if (disabled || !selectionValid || busy) return
    setBusy(true); setError(''); setPreview(null)
    try { setPreview(await previewResize(server.id, selected, upgradeDisk)) }
    catch (error) { setError(error instanceof Error ? error.message : 'دریافت قیمت ناموفق بود.') }
    finally { setBusy(false) }
  }
  return <><p className="server-notice">تغییر پلن به سرور خاموش نیاز دارد. کاهش ظرفیت دیسک و تغییر معماری مجاز نیست. هزینهٔ دوره‌های تسویه‌شده تغییر نمی‌کند.</p>
    {options.loading ? <LoadingState /> : options.error ? <QueryError message={options.error} onRetry={options.refetch} />
      : eligible.length === 0 ? <p>پلن سازگاری برای این سرور پیدا نشد.</p>
        : <div className="server-resize-grid">{eligible.map(option => <button key={option.offerId} className={`server-resize-option ${selected === option.offerId ? 'is-selected' : ''}`} disabled={disabled || busy} aria-pressed={selected === option.offerId} onClick={() => { setSelected(option.offerId); setPreview(null) }}><strong>{option.type}</strong><span>{option.vcpu} vCPU · {option.memoryMb / 1024} GB RAM</span><span>{option.diskGb} GB · {option.architecture}</span></button>)}</div>}
    <Card><h2>پیش‌نمایش صورتحساب</h2><label className="server-checkbox"><input type="checkbox" checked={upgradeDisk} disabled={disabled || busy} onChange={event => { setUpgradeDisk(event.target.checked); setPreview(null) }} />افزایش دائمی ظرفیت دیسک را می‌خواهم؛ بازگشت به دیسک کوچک‌تر ممکن نیست.</label>
      <Button disabled={disabled || !selectionValid || busy} onClick={estimate}>بررسی قیمت و محدودیت‌ها</Button>
      {preview && <div className="server-price-preview"><p>قیمت قبل: {amount(preview.currentPriceRial)} · قیمت جدید: {amount(preview.priceRial)} / {periodLabels[preview.period]}</p><p>برداشت فوری: {amount(preview.immediateChargeRial)} · اعمال در تمدیدهای آتی پس از تأیید تغییر</p><p>اعتبار قیمت: {formatFaDateTime(preview.expiresAt)}</p><Button disabled={disabled || !selectionValid || Date.now() >= new Date(preview.expiresAt).getTime()} onClick={() => ask('resize', { quoteId: preview.quoteId, upgradeDisk: preview.upgradeDisk })}>تأیید تغییر پلن</Button></div>}
      {error && <p role="alert">{error}</p>}
    </Card></>
}
function ServerStorage({ server }: { server: ServerDetail }) {
  return <><p className="server-notice">{server.capabilities.unavailableReason}</p><div className="server-detail-columns"><Card><h2>اسنپ‌شات‌ها و بکاپ‌ها</h2><p>ساخت و بازیابی Snapshot با تعرفه و مالکیت مستقل هنوز در این فروشگاه فعال نیست.</p><p>بکاپ ارائه‌دهنده: {server.facts?.backupWindow || 'وضعیت فعال اعلام نشده است'}</p></Card><Card><h2>Volumeهای متصل</h2>{server.facts ? server.facts.volumes.length ? server.facts.volumes.map(id => <p key={id}>Volume ID: <bdi>{id}</bdi></p>) : <p>Volume متصلی گزارش نشده است.</p> : <p>{missing}</p>}<p>منابع مستقل ممکن است پس از حذف VM باقی بمانند.</p></Card></div></>
}
function ServerNetwork({ server, disabled, ask }: { server: ServerDetail; disabled: boolean; ask: (action: ManagementAction, input?: Record<string, unknown>) => void }) {
  const f = server.facts
  return <div className="server-detail-columns"><Card><h2>شبکه و آدرس‌ها</h2><dl className="server-facts"><div><dt>IPv4</dt><dd><bdi>{f?.ipv4 ?? missing}</bdi></dd></div><div><dt>IPv6</dt><dd><bdi>{f?.ipv6 ?? missing}</bdi></dd></div><div><dt>Floating IP</dt><dd>{f ? f.floatingIps.join('، ') || 'گزارش نشده' : missing}</dd></div></dl>{f?.privateNetworks.map(network => <p key={network.id}>شبکهٔ خصوصی {network.id}: <bdi>{network.ip}</bdi></p>)}<p className="server-muted">تغییر شبکه و منابع مشترک پروژه بدون اثبات مالکیت اختصاصی مجاز نیست.</p></Card>
    <Card><h2>Firewall، Rescue و حفاظت</h2>{f?.firewalls.map(firewall => <p key={firewall.id}>Firewall ID: {firewall.id} · {firewall.status}</p>)}<p>Rescue: {f?.rescueEnabled == null ? missing : f.rescueEnabled ? 'فعال' : 'غیرفعال'}</p>
      <div className="server-inline-actions"><Button variant="secondary" disabled={disabled || f?.rescueEnabled == null} onClick={() => ask(f?.rescueEnabled ? 'disable_rescue' : 'enable_rescue')}>{f?.rescueEnabled ? 'غیرفعال‌سازی Rescue' : 'فعال‌سازی Rescue'}</Button><Button variant="secondary" disabled={disabled || !f?.isoId} onClick={() => ask('detach_iso')}>قطع ISO متصل</Button></div><p>انتخاب و اتصال ISO جدید در این پروژه فعال نیست.</p>
      {f?.protection && <><p>حفاظت حذف: {f.protection.delete ? 'فعال' : 'غیرفعال'} · حفاظت Rebuild: {f.protection.rebuild ? 'فعال' : 'غیرفعال'}</p><div className="server-inline-actions"><Button variant="secondary" disabled={disabled} onClick={() => ask('change_protection', { delete: !f.protection!.delete, rebuild: f.protection!.rebuild })}>تغییر حفاظت حذف</Button><Button variant="secondary" disabled={disabled} onClick={() => ask('change_protection', { delete: f.protection!.delete, rebuild: !f.protection!.rebuild })}>تغییر حفاظت Rebuild</Button></div></>}
    </Card></div>
}
