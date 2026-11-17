import { useEffect, useRef, useState } from 'react'
import { embeddedPrices, isPublicHomePrices, publicLocation, renderHomeTariffs, type PublicHomePrices, type TariffScope } from '../../backend/src/contracts/home-tariffs'

export const fallbackTariffs = renderHomeTariffs(null, null)
export function HomeTariffs({ initialHtml, scope = 'all' }: { initialHtml?: string; scope?: TariffScope }) {
  const [data, setData] = useState<PublicHomePrices | null>(() => embeddedPrices(initialHtml ?? ''))
  const [loading, setLoading] = useState(!initialHtml)
  const [warning, setWarning] = useState('')
  const [expired, setExpired] = useState(false)
  const [location, setLocation] = useState(''), [sort, setSort] = useState<'hourly' | 'monthly'>('hourly')
  const [retry, setRetry] = useState(0)
  const [expiresAt, setExpiresAt] = useState(() => Math.min(embeddedPrices(initialHtml ?? '') ? Date.parse(embeddedPrices(initialHtml!)!.meta.validUntil) : Date.now() + 60_000, Date.now() + 60_000))
  const mounted = useRef(true)
  const hasSnapshot = useRef(!!data?.hetzner?.length || !!initialHtml)
  useEffect(() => {
    setExpired(expiresAt <= Date.now())
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [expiresAt])
  useEffect(() => {
    mounted.current = true
    let active = new AbortController()
    const refresh = async () => {
      active.abort()
      const controller = new AbortController(); active = controller
      setLoading(true)
      try {
        const response = await fetch('/api/public/home-prices', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
        if (!response.ok) throw new Error('Tariffs unavailable')
        const body: unknown = await response.json()
        const next = (body as { data?: unknown })?.data
        if (!isPublicHomePrices(next)) throw new Error('Invalid public price response')
        if (controller.signal.aborted || !mounted.current) return
        if (next.hetzner === null) {
          // A transient/null result cannot erase a still-valid SSR snapshot or extend its lifetime.
          setWarning(next.meta.status === 'pricing_unavailable' ? 'نرخ ارز معتبر هنوز آماده نیست؛ قیمت قبلی فقط تا پایان اعتبارش قابل مقایسه است.' : 'به‌روزرسانی قیمت انجام نشد؛ قیمت قبلی فقط تا پایان اعتبارش نمایش داده می‌شود.')
          if (!hasSnapshot.current) setData(next)
          return
        }
        setData(next); hasSnapshot.current = true; setExpired(false); setWarning('')
        setLocation(current => next.hetzner?.some(o => o.location === current) ? current : '')
        setExpiresAt(Math.min(Date.parse(next.meta.validUntil), Date.now() + 60_000))
      } catch {
        if (!controller.signal.aborted && mounted.current) setWarning('به‌روزرسانی قیمت انجام نشد؛ این ارقام آخرین بررسی هستند، نه قیمت قطعی سفارش.')
      } finally { if (!controller.signal.aborted && mounted.current) setLoading(false) }
    }
    if (!initialHtml || retry > 0) void refresh()
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 30_000)
    const resume = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', refresh)
    return () => { mounted.current = false; active.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh) }
    // The last successful snapshot is retained across request failures; it never refreshes the expiry timer.
  }, [initialHtml, retry])
  const offers = data?.hetzner?.filter(offer => !location || offer.location === location) ?? null
  const snapshotExpired = expired && (!!data?.hetzner?.length || (!data && !!initialHtml))
  const html = snapshotExpired ? renderHomeTariffs(null, null, undefined, scope)
    : data ? renderHomeTariffs(data.iran, offers, data.meta, scope, sort) : initialHtml ?? renderHomeTariffs(null, null, undefined, scope)
  const locations = data?.hetzner ? [...new Map(data.hetzner.map(offer => [offer.location, publicLocation(offer)])).entries()] : []
  return <section id="tariffs" className="landing-section public-container landing-tariffs" aria-labelledby="tariffs-title">
    <h2 id="tariffs-title">{scope === 'hetzner' ? 'مقایسهٔ قیمت سرور هتزنر' : 'تعرفه‌ها'}</h2>
    <p>پرداخت ماهانه برای ماه پرداخت‌شده ثابت است؛ هزینهٔ هر ساعت بعدی با نرخ معتبر همان ساعت محاسبه می‌شود. گردکردن نمایشی مبنای برداشت نیست.</p>
    {loading && <p role="status">در حال دریافت تعرفه‌ها…</p>}
    {warning && <p role="status">{warning}</p>}
    {snapshotExpired && <p role="status">اعتبار این بررسی تمام شده است؛ برای جلوگیری از نمایش مبلغ قدیمی، قیمت‌ها تا بررسی دوباره پنهان‌اند.</p>}
    {!!data?.hetzner?.length && !snapshotExpired && <div className="tariff-filters">
      <label>موقعیت دیتاسنتر<select value={location} onChange={event => setLocation(event.target.value)}><option value="">همهٔ موقعیت‌ها</option>{locations.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <label>مقایسه از کم‌هزینه به بیشتر<select value={sort} onChange={event => setSort(event.target.value as 'hourly' | 'monthly')}><option value="hourly">قیمت هر ساعت</option><option value="monthly">قیمت هر ماه</option></select></label>
    </div>}
    <div id="home-tariff-content" dangerouslySetInnerHTML={{ __html: html }} />
    {(warning || snapshotExpired) && <button className="button primary" disabled={loading} onClick={() => setRetry(v => v + 1)}>بررسی دوبارهٔ قیمت‌ها</button>}
  </section>
}
