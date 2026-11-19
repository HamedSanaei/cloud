import { useEffect, useId, useRef, useState } from 'react'
import { embeddedPrices, hetznerTariffHeading, isPublicHomePrices, publicLocation, renderHomeTariffs, renderTariffSections, tariffCountryCode, tariffCountryName, tariffFlagEmoji, tariffFlagImage, type PublicHomePrices, type TariffScope } from '../../backend/src/contracts/home-tariffs'
import { defaultTariffSort, type TariffSort } from '../../backend/src/contracts/home-tariffs'

export const fallbackTariffs = renderHomeTariffs(null, null)
const sortOptions = [
  ['price:asc', 'قیمت کم به زیاد'], ['price:desc', 'قیمت زیاد به کم'],
  ['name:asc', 'نام پلن، صعودی'], ['name:desc', 'نام پلن، نزولی'],
  ['location:asc', 'لوکیشن، صعودی'], ['location:desc', 'لوکیشن، نزولی'],
  ['vcpu:asc', 'پردازنده، کم به زیاد'], ['vcpu:desc', 'پردازنده، زیاد به کم'],
  ['memoryMb:asc', 'RAM، کم به زیاد'], ['memoryMb:desc', 'RAM، زیاد به کم'],
  ['diskGb:asc', 'دیسک، کم به زیاد'], ['diskGb:desc', 'دیسک، زیاد به کم'],
  ['traffic:asc', 'ترافیک مجاز رایگان، کم به زیاد'], ['traffic:desc', 'ترافیک مجاز رایگان، زیاد به کم'],
] as const

function pinTariffHeader(section: HTMLElement) {
  const scroll = section.querySelector<HTMLElement>('.tariff-scroll--hetzner')
  const table = scroll?.querySelector('table')
  const head = table?.tHead, body = table?.tBodies[0]
  if (!scroll || !table || !head || !body || !window.matchMedia) return
  const compact = window.matchMedia('(max-width: 1024px)')
  const navbar = section.closest('.landing-page')?.querySelector('.landing-header')
  let frame = 0
  const update = () => {
    frame = 0
    const navbarHeight = Math.ceil(navbar?.getBoundingClientRect().height ?? 0)
    section.style.setProperty('--tariff-header-top', `${navbarHeight}px`)
    scroll.toggleAttribute('data-page-sticky', compact.matches)
    if (!compact.matches) return
    // Use the native row as the header so it moves horizontally with the same columns.
    const bounds = body.getBoundingClientRect(), height = head.getBoundingClientRect().height
    const offset = Math.min(bounds.height, Math.max(0, navbarHeight - (bounds.top - height)))
    head.style.setProperty('--tariff-header-shift', `${offset}px`)
  }
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update) }
  update()
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  observer?.observe(table)
  if (navbar) observer?.observe(navbar)
  return () => {
    observer?.disconnect()
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    window.cancelAnimationFrame(frame)
  }
}

export function HomeTariffs({ initialHtml, scope = 'all' }: { initialHtml?: string; scope?: TariffScope }) {
  const locationFilterId = useId(), sortFilterId = useId(), priceBasisId = useId()
  const [data, setData] = useState<PublicHomePrices | null>(() => embeddedPrices(initialHtml ?? ''))
  const [loading, setLoading] = useState(!initialHtml)
  const [warning, setWarning] = useState('')
  const [expired, setExpired] = useState(false)
  const [{ country, location }, setFilters] = useState({ country: '', location: '' })
  const [sort, setSort] = useState<TariffSort>(defaultTariffSort)
  const [retry, setRetry] = useState(0)
  const [expiresAt, setExpiresAt] = useState(() => Math.min(data ? Date.parse(data.meta.validUntil) : Infinity, Date.now() + 60_000))
  const mounted = useRef(true)
  const tariffs = useRef<HTMLElement>(null)
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
        setFilters(current => next.hetzner?.some(o => o.location === current.location && (!current.country || tariffCountryCode(o.country) === current.country))
          ? current : { ...current, location: '' })
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
  const countryOffers = data?.hetzner?.filter(offer => !country || tariffCountryCode(offer.country) === country) ?? null
  const offers = countryOffers?.filter(offer => !location || offer.location === location) ?? null
  const countries = [...new Set(data?.hetzner?.map(offer => tariffCountryCode(offer.country)).filter(Boolean))]
    .sort((a, b) => tariffCountryName(a).localeCompare(tariffCountryName(b), 'fa'))
  const locations = [...new Map(countryOffers?.map(offer => [offer.location, publicLocation(offer)]))]
  const selectCountry = (code: string) => setFilters(current => ({
    country: code,
    location: code && data?.hetzner?.some(o => o.location === current.location && tariffCountryCode(o.country) === code) ? current.location : '',
  }))
  const snapshotExpired = expired && (!!data?.hetzner?.length || (!data && !!initialHtml))
  const sections = data && !snapshotExpired ? renderTariffSections(data.iran, offers, data.meta, scope, sort, !!country) : null
  const visibleHtml = sections?.hetzner ?? (!snapshotExpired && initialHtml ? initialHtml : renderHomeTariffs(null, null, undefined, scope))
  useEffect(() => { if (tariffs.current) return pinTariffHeader(tariffs.current) }, [visibleHtml])
  return <section ref={tariffs} id="tariffs" className="landing-section public-container landing-tariffs" aria-labelledby="tariffs-title">
    <h2 id="tariffs-title">{scope === 'hetzner' ? 'مقایسهٔ قیمت سرور هتزنر' : 'تعرفه‌ها'}</h2>
    <p>پرداخت ماهانه برای ماه پرداخت‌شده ثابت است؛ هزینهٔ هر ساعت بعدی با نرخ معتبر همان ساعت محاسبه می‌شود. گردکردن نمایشی مبنای برداشت نیست.</p>
    {loading && <p role="status">در حال دریافت تعرفه‌ها…</p>}
    {warning && <p role="status">{warning}</p>}
    {snapshotExpired && <p role="status">اعتبار این بررسی تمام شده است؛ برای جلوگیری از نمایش مبلغ قدیمی، قیمت‌ها تا بررسی دوباره پنهان‌اند.</p>}
    {sections ? <div id="home-tariff-content">
      {sections.iran && <div dangerouslySetInnerHTML={{ __html: sections.iran }} />}
      <section id="hetzner-server" aria-labelledby="hetzner-tariff-heading">
        <div className="tariff-header">
          <h3 id="hetzner-tariff-heading">{hetznerTariffHeading}</h3>
          {!!locations.length && <div className="tariff-filters">
            <div className="tariff-filter">
              <label htmlFor={locationFilterId}>موقعیت دیتاسنتر</label>
              <select id={locationFilterId} value={location} onChange={event => setFilters({ country, location: event.target.value })}>
                <option value="">همهٔ موقعیت‌ها</option>
                {locations.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </div>
            <div className="tariff-filter">
              <label htmlFor={sortFilterId}>مرتب‌سازی بر اساس</label>
              <select id={sortFilterId} value={`${sort.by}:${sort.direction}`} onChange={event => {
                const [by, direction] = event.target.value.split(':') as [TariffSort['by'], TariffSort['direction']]
                setSort(current => ({ ...current, by, direction }))
              }}>
                {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="tariff-filter">
              <label htmlFor={priceBasisId}>مبنای قیمت</label>
              <select id={priceBasisId} value={sort.period} onChange={event => {
                const period = event.target.value === 'monthly' ? 'monthly' : 'hourly'
                setSort(current => ({ ...current, period }))
              }}>
                <option value="hourly">ساعتی</option><option value="monthly">ماهانه</option>
              </select>
            </div>
          </div>}
        </div>
        {(!!data?.hetzner?.length || !!country) && <div className="tariff-country-list" role="group" aria-label="کشور دیتاسنتر">
          <button type="button" aria-pressed={!country} onClick={() => selectCountry('')}>همه کشورها</button>
          {countries.map(code => {
            const name = tariffCountryName(code), image = tariffFlagImage(code)
            return <button key={code} type="button" aria-label={name} aria-pressed={country === code} onClick={event => {
              event.currentTarget.focus({ preventScroll: true })
              selectCountry(code)
            }}>
              {image ? <img src={image} alt="" width={24} height={16} /> : <span className="tariff-flag-emoji" aria-hidden="true">{tariffFlagEmoji(code)}</span>}
              <span className="tariff-country-tip" aria-hidden="true">{name}</span>
            </button>
          })}
        </div>}
        <div className="tariff-body" dangerouslySetInnerHTML={{ __html: sections.hetzner }} />
      </section>
    </div> : <div id="home-tariff-content" dangerouslySetInnerHTML={{ __html: visibleHtml }} />}
    {(warning || snapshotExpired) && <button className="button primary" disabled={loading} onClick={() => setRetry(v => v + 1)}>بررسی دوبارهٔ قیمت‌ها</button>}
  </section>
}
