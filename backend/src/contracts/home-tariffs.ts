export const iranResources = {
  outbound: 'ترافیک خروجی (دانلود از سرور)', inbound: 'ترافیک ورودی (آپلود به سرور)',
  cpu: 'پردازندهٔ مجازی', ram: 'حافظهٔ RAM',
} as const
export type IranResource = keyof typeof iranResources
export type IranTariffs = {
  rates: Record<IranResource, number | null>
  trafficUnit: 'TB' | 'TiB'
  tax: 'included' | 'excluded'
}
export interface PublicHetznerOffer {
  id: string; name: string; location: string; country?: string | null; city?: string | null; vcpu: number; memoryMb: number; diskGb: number; diskType?: string; trafficGb: number | null
  hourly: number | null; monthly: number | null
  includedTrafficBytes?: number | null
  trafficOverage?: IndicativeTrafficTariff | null
}
export interface IndicativeTrafficTariff {
  perTbRial: number
  includedBytes: number | null
  source: 'hetzner-server-type-location'
  observedAt: string
  fxAt: string
  ruleVersion: string
}
export const isTrafficByteCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const indicativeOverageNotice = 'سهمیه با واحد کنسول هتزنر (۲ به توان ۴۰ بایت) نمایش داده می‌شود. نرخ استعلامی ترافیک مازاد به ازای هر TB ده‌دهی (۱٬۰۰۰ گیگابایت) است و فعلاً در پارس سرور قابل پرداخت نیست.'
export interface PublicTariffMeta {
  checkedAt: string; validUntil: string; catalogUpdatedAt: string | null; fxUpdatedAt: string | null
  status: 'available' | 'unavailable' | 'not_published' | 'pricing_unavailable' | 'temporarily_unavailable'
}
export interface PublicHomePrices { iran: IranTariffs | null; hetzner: PublicHetznerOffer[] | null; meta: PublicTariffMeta }
export type TariffScope = 'all' | 'hetzner'
export function isPublicHomePrices(value: unknown): value is PublicHomePrices {
  if (!value || typeof value !== 'object') return false
  const data = value as PublicHomePrices
  if (!data.meta || !['available', 'unavailable', 'not_published', 'pricing_unavailable', 'temporarily_unavailable'].includes(data.meta.status) ||
      ![data.meta.checkedAt, data.meta.validUntil].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v))) ||
      ![data.meta.catalogUpdatedAt, data.meta.fxUpdatedAt].every(v => v === null || typeof v === 'string' && Number.isFinite(Date.parse(v)))) return false
  if (data.iran !== null && (!data.iran?.rates || !['TB', 'TiB'].includes(data.iran.trafficUnit) || !['included', 'excluded'].includes(data.iran.tax) ||
      !Object.keys(iranResources).every(key => { const v = data.iran!.rates[key as IranResource]; return v === null || Number.isSafeInteger(v) && v >= 0 && v <= iranRateMaximum }))) return false
  return data.hetzner === null || Array.isArray(data.hetzner) && data.hetzner.every(o =>
    o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.location === 'string' &&
    [o.diskType, o.country, o.city].every(v => v == null || typeof v === 'string') &&
    [o.vcpu, o.memoryMb, o.diskGb].every(v => Number.isFinite(v) && v > 0) &&
    [o.hourly, o.monthly].every(v => v === null || Number.isSafeInteger(v) && v > 0) &&
    (o.includedTrafficBytes == null || isTrafficByteCount(o.includedTrafficBytes)) &&
    (o.trafficOverage == null || (o.trafficOverage.source === 'hetzner-server-type-location' &&
      Number.isSafeInteger(o.trafficOverage.perTbRial) && o.trafficOverage.perTbRial > 0 &&
      (o.trafficOverage.includedBytes === null || isTrafficByteCount(o.trafficOverage.includedBytes)) &&
      [o.trafficOverage.observedAt, o.trafficOverage.fxAt, o.trafficOverage.ruleVersion].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v))))) &&
    (o.trafficGb === null || Number.isFinite(o.trafficGb) && o.trafficGb >= 0))
}
export function embeddedPrices(html: string): PublicHomePrices | null {
  const json = html.match(/<script id="home-prices-state" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
  try { const parsed: unknown = JSON.parse(json ?? 'null'); return isPublicHomePrices(parsed) ? parsed : null } catch { return null }
}
export function sortHetznerOffers(offers: PublicHetznerOffer[], period: 'hourly' | 'monthly') {
  return [...offers].sort((a, b) => (a[period] ?? Infinity) - (b[period] ?? Infinity) || a.name.localeCompare(b.name) || a.location.localeCompare(b.location))
}
export function publicLocation(offer: Pick<PublicHetznerOffer, 'location' | 'country' | 'city'>) {
  let country = ''
  if (offer.country && /^[a-z]{2}$/i.test(offer.country)) country = new Intl.DisplayNames(['fa'], { type: 'region' }).of(offer.country.toUpperCase()) ?? ''
  return [country, offer.city, offer.location].filter(Boolean).join('، ')
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const number = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 3 })
export const hetznerTrafficQuota = (bytes: number | null | undefined) => isTrafficByteCount(bytes) ? `${number.format(bytes / 2 ** 40)} TB` : 'اعلام نشده'
export const tariffTime = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' })
const toman = (rial: number) => `${number.format(rial / 10)} تومان`
const inquiry = 'استعلام قیمت'
export const iranRateMaximum = 1_000_000_000_000
const wrapTable = (caption: string, headings: string[], body: string) => `<div class="tariff-scroll" tabindex="0" role="region" aria-label="${caption}"><table><caption>${caption}</caption><thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`

export function renderHomeTariffs(iran: IranTariffs | null, hetzner: PublicHetznerOffer[] | null, meta?: PublicTariffMeta, scope: TariffScope = 'all', sort: 'hourly' | 'monthly' = 'hourly') {
  const iranRows = (Object.keys(iranResources) as IranResource[]).map(key => {
    const rate = iran?.rates[key]
    const unit = key === 'cpu' ? '۱ هسته vCPU' : key === 'ram' ? '۱ گیگابایت RAM' : iran ? `۱ ${escapeHtml(iran.trafficUnit)}` : 'واحد پس از تأیید قرارداد'
    return `<tr><th scope="row">${iranResources[key]}</th><td><bdi>${unit}</bdi></td><td>${rate == null ? inquiry : toman(rate)}</td></tr>`
  }).join('')
  const buy = (offer: PublicHetznerOffer, period: 'hourly' | 'monthly') => {
    const price = offer[period]
    if (price === null) return period === 'monthly' ? 'قیمت ماهانهٔ معتبر در دسترس نیست' : 'قیمت ساعتی معتبر در دسترس نیست'
    const label = period === 'hourly' ? 'ساعتی' : 'ماهانه'
    return `<bdi>${toman(price)}</bdi><br><a href="/servers/create?offer=${encodeURIComponent(offer.id)}&amp;period=${period}&amp;location=${encodeURIComponent(offer.location)}" aria-label="خرید ${escapeHtml(offer.name)} ${label} در ${escapeHtml(offer.location)}">انتخاب ${label}</a>`
  }
  const hetznerTable = hetzner?.length ? '<p class="tariff-scroll-hint">برای دیدن همهٔ قیمت‌ها، جدول را افقی پیمایش کنید.</p>' +
    wrapTable('پلن‌های قابل سفارش هتزنر', ['پلن', 'موقعیت', 'vCPU', 'RAM', 'دیسک', 'ترافیک ماهانهٔ مشمول', 'ساعتی (تومان / ساعت)', 'ماهانه (تومان / ماه)', 'قیمت هر ترابایت ترافیک مازاد (تومان / TB)'],
    sortHetznerOffers(hetzner, sort).map(offer => `<tr><th scope="row"><bdi>${escapeHtml(offer.name)}</bdi></th><td><bdi>${escapeHtml(publicLocation(offer))}</bdi></td>` +
      `<td>${number.format(offer.vcpu)}</td><td>${number.format(offer.memoryMb / 1024)} گیگابایت</td><td>${number.format(offer.diskGb)} گیگابایت${offer.diskType ? ` <bdi>${escapeHtml(offer.diskType)}</bdi>` : ''}</td>` +
      `<td><bdi>${hetznerTrafficQuota(offer.includedTrafficBytes ?? offer.trafficOverage?.includedBytes)}</bdi></td>` +
      `<td>${buy(offer, 'hourly')}</td><td>${buy(offer, 'monthly')}</td><td>${offer.trafficOverage ? `<bdi>${toman(offer.trafficOverage.perTbRial)}</bdi><br>استعلامی` : 'نرخ معتبر در دسترس نیست'}</td></tr>`).join(''))
    : `<p role="status">${meta?.status === 'pricing_unavailable' ? 'نرخ ارز معتبر برای محاسبهٔ قیمت هتزنر در دسترس نیست؛ پس از تأیید نرخ تازه، قیمت‌ها نمایش داده می‌شوند.' : hetzner === null ? 'دریافت تعرفهٔ هتزنر موقتاً ممکن نیست.' : 'در حال حاضر پلن قابل سفارش هتزنر برای نمایش وجود ندارد.'}</p>`
  const iranSection = `<section id="iran-server"><h3>تعرفه سرور ایران (ماهانه)</h3>` +
    (iran ? `<p>${iran.trafficUnit === 'TB' ? 'هر TB برابر ۱٬۰۰۰ GB است.' : 'هر TiB برابر ۱٬۰۲۴ GiB است.'} نرخ‌ها ${iran.tax === 'included' ? 'شامل مالیات هستند' : 'بدون مالیات هستند'}.</p>`
      : '<p>تعرفهٔ تأییدشدهٔ آسیاتک هنوز منتشر نشده است. برای خرید سرور ایران، وضعیت عرضه و قیمت را از پشتیبانی استعلام کنید.</p>') +
    wrapTable('نرخ واحد منابع سرور ایران', ['منبع', 'واحد', 'قیمت ماهانه'], iranRows) +
    '<p>این ارقام نرخ واحد منابع‌اند. هزینهٔ دیسک، IPv4 و بسته‌های اضافی در قیمت کامل ماشین مشخص می‌شود.</p></section>'
  const date = (value: string) => `<time datetime="${escapeHtml(value)}">${tariffTime.format(new Date(value))}</time>`
  const time = meta ? `<p class="tariff-freshness">بررسی قیمت: ${date(meta.checkedAt)} (تهران).${meta.catalogUpdatedAt ? ` تعرفهٔ کاتالوگ: ${date(meta.catalogUpdatedAt)}.` : ''}${meta.fxUpdatedAt ? ` نرخ ارز: ${date(meta.fxUpdatedAt)}.` : ''} این جدول پیش‌فاکتور قطعی نیست.</p>` : ''
  const cheapest = hetzner?.length ? sortHetznerOffers(hetzner, sort).find(o => o[sort] !== null) : null
  const affordable = cheapest ? `<p>کم‌هزینه‌ترین گزینهٔ همین فهرست برای پرداخت ${sort === 'hourly' ? 'ساعتی' : 'ماهانه'}: <bdi>${escapeHtml(cheapest.name)}</bdi> در <bdi>${escapeHtml(publicLocation(cheapest))}</bdi>، <bdi>${toman(cheapest[sort]!)}</bdi>. این مقایسه فقط بین پلن‌های منتشرشدهٔ پارس سرور است.</p>` : ''
  const state = meta ? `<script id="home-prices-state" type="application/json">${JSON.stringify({ iran, hetzner, meta }).replace(/</g, '\\u003c')}</script>` : ''
  return (scope === 'all' ? iranSection : '') +
    `<section id="hetzner-server"><h3>تعرفه سرور هتزنر</h3><p>مبالغ جدول شامل مالیاتِ تنظیم‌شده‌اند. قیمت و موجودی پلن هنگام سفارش دوباره بررسی می‌شوند.</p><p>${indicativeOverageNotice}</p>${time}${affordable}${hetznerTable}</section>${state}`
}
