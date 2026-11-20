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
export const indicativeOverageNotice = 'حجم ترافیک و نرخ مازاد بر مبنای TB ده‌دهی (هر TB برابر ۱٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ بایت) نمایش داده می‌شوند. هزینهٔ مازاد ساعتی محاسبه می‌شود و بر اساس مصرف ثبت‌شده در کیف پول و فاکتور درج می‌شود.'
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
export type TariffPeriod = 'hourly' | 'monthly'
export type TariffSort = { by: 'name' | 'location' | 'price' | 'vcpu' | 'memoryMb' | 'diskGb' | 'traffic'; direction: 'asc' | 'desc'; period: TariffPeriod }
export const defaultTariffSort: TariffSort = { by: 'price', direction: 'asc', period: 'monthly' }
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const compareLocation = (a: PublicHetznerOffer, b: PublicHetznerOffer) =>
  natural.compare(tariffCountryCode(a.country) || 'ZZ', tariffCountryCode(b.country) || 'ZZ')
  || natural.compare(a.city ?? '', b.city ?? '') || natural.compare(a.location, b.location)
export function sortHetznerOffers(offers: PublicHetznerOffer[], sort: TariffSort | TariffPeriod = defaultTariffSort) {
  const { by, direction, period }: TariffSort = typeof sort === 'string' ? { by: 'price', direction: 'asc', period: sort } : sort
  function value(offer: PublicHetznerOffer) {
    if (by === 'price') return offer[period]
    if (by === 'traffic') {
      const bytes = offer.includedTrafficBytes ?? offer.trafficOverage?.includedBytes
      return isTrafficByteCount(bytes) ? bytes : null
    }
    return by === 'name' || by === 'location' ? null : offer[by]
  }
  return [...offers].sort((a, b) => {
    let order: number
    if (by === 'name') order = natural.compare(a.name, b.name)
    else if (by === 'location') order = compareLocation(a, b)
    else {
      const first = value(a), second = value(b)
      if ((first === null) !== (second === null)) return first === null ? 1 : -1
      order = (first ?? 0) - (second ?? 0)
    }
    return (direction === 'asc' ? order : -order) || natural.compare(a.name, b.name)
      || natural.compare(a.location, b.location) || a.id.localeCompare(b.id)
  })
}
// Officially assigned ISO 3166-1 alpha-2 codes. The catalog supplies the available filters.
const countryCodes = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' '))
const countryNames = new Intl.DisplayNames('fa', { type: 'region' })
export function tariffCountryCode(country: string | null | undefined) {
  const code = country?.trim().toUpperCase() ?? ''
  return countryCodes.has(code) ? code : ''
}
export const tariffCountryName = (code: string) => countryNames.of(code) ?? code
export const tariffFlagImage = (code: string) => ['DE', 'FI', 'US', 'SG'].includes(code) ? `/flags/${code.toLowerCase()}.svg` : undefined
export const tariffFlagEmoji = (code: string) => String.fromCodePoint(...Array.from(code, char => char.charCodeAt(0) + 0x1f1a5))
export function publicLocation(offer: Pick<PublicHetznerOffer, 'location' | 'country' | 'city'>) {
  const code = tariffCountryCode(offer.country)
  return [code ? tariffCountryName(code) : '', offer.city, offer.location].filter(Boolean).join('، ')
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
function locationCell(offer: PublicHetznerOffer) {
  const code = tariffCountryCode(offer.country)
  const place = `<bdi>${escapeHtml([offer.city, offer.location].filter(Boolean).join('، '))}</bdi>`
  if (!code) return `<td><div class="tariff-location"><small>کشور نامشخص</small>${place}</div></td>`
  const name = escapeHtml(tariffCountryName(code)), image = tariffFlagImage(code)
  const flag = image ? `<img src="${image}" width="24" height="16" alt="" loading="lazy">` : `<span class="tariff-flag-emoji" aria-hidden="true">${tariffFlagEmoji(code)}</span>`
  return `<td><div class="tariff-location"><details class="tariff-location-flag" name="tariff-location-countries"><summary aria-label="${name}">${flag}<span class="tariff-country-tip" aria-hidden="true">${name}</span></summary></details>${place}</div></td>`
}
const number = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 3 })
const trafficNumber = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 12 })
const moneyDisplay = new Intl.NumberFormat('fa-IR', { useGrouping: true, maximumFractionDigits: 0 })
export const bytesPerTb = 1_000_000_000_000
export const hetznerTrafficBlockBytes = 100_000_000
export const formatTrafficTb = (bytes: number | null | undefined) => isTrafficByteCount(bytes) ? `${trafficNumber.format(bytes / bytesPerTb)} TB` : 'اعلام نشده'
export function decimalIranTariffs(tariffs: IranTariffs): IranTariffs {
  if (tariffs.trafficUnit === 'TB') return tariffs
  // Historical tariffs are quoted per 2^40 bytes. Project to the nearest rial per decimal TB.
  const oldUnit = 2n ** 40n
  const perTb = (rate: number | null) => rate === null ? null : Number((BigInt(rate) * BigInt(bytesPerTb) + oldUnit / 2n) / oldUnit)
  return { ...tariffs, trafficUnit: 'TB', rates: { ...tariffs.rates, inbound: perTb(tariffs.rates.inbound), outbound: perTb(tariffs.rates.outbound) } }
}
export const tariffTime = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' })
const toman = (rial: number) => `${moneyDisplay.format(rial / 10)} تومان`
const inquiry = 'استعلام قیمت'
export const iranRateMaximum = 1_000_000_000_000
const wrapTable = (caption: string, headings: string[], body: string, hetzner = false) => `<div class="tariff-scroll${hetzner ? ' tariff-scroll--hetzner' : ''}" tabindex="0" role="region" aria-label="${caption}"><table><caption>${caption}</caption><thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`

export const hetznerTariffHeading = 'تعرفه سرور هتزنر'

export function renderTariffSections(iran: IranTariffs | null, hetzner: PublicHetznerOffer[] | null, meta?: PublicTariffMeta, scope: TariffScope = 'all', sort: TariffSort | TariffPeriod = defaultTariffSort, countryFiltered = false) {
  const period = typeof sort === 'string' ? sort : sort.period
  const otherPeriod = period === 'monthly' ? 'hourly' : 'monthly'
  const decimalIran = iran && decimalIranTariffs(iran)
  const iranRows = (Object.keys(iranResources) as IranResource[]).map(key => {
    const rate = decimalIran?.rates[key]
    const unit = key === 'cpu' ? '۱ هسته vCPU' : key === 'ram' ? '۱ گیگابایت RAM' : '۱ TB'
    return `<tr><th scope="row">${iranResources[key]}</th><td><bdi>${unit}</bdi></td><td>${rate == null ? inquiry : toman(rate)}</td></tr>`
  }).join('')
  const displayPrice = (price: number | null, period: 'hourly' | 'monthly') => price === null
    ? (period === 'monthly' ? 'قیمت ماهانهٔ معتبر در دسترس نیست' : 'قیمت ساعتی معتبر در دسترس نیست')
    : `<bdi>${toman(price)}</bdi>`
  const planLink = (offer: PublicHetznerOffer) => {
    const name = `<bdi>${escapeHtml(offer.name)}</bdi>`
    const orderPeriod = offer[period] !== null ? period : otherPeriod
    if (offer[orderPeriod] === null) return name
    const label = orderPeriod === 'hourly' ? 'ساعتی' : 'ماهانه'
    const periodNote = orderPeriod === period ? '' : `<small class="tariff-plan-period">سفارش ${label}</small>`
    return `<a href="/servers/create?offer=${encodeURIComponent(offer.id)}&amp;period=${orderPeriod}&amp;location=${encodeURIComponent(offer.location)}" aria-label="خرید ${escapeHtml(offer.name)} ${label} در ${escapeHtml(offer.location)}">${name}${periodNote}</a>`
  }
  const sorted = sortHetznerOffers(hetzner ?? [], sort)
  const hetznerTable = hetzner?.length ? '<p class="tariff-scroll-hint">برای دیدن همهٔ قیمت‌ها، جدول را افقی پیمایش کنید.</p>' +
    wrapTable('پلن‌های قابل سفارش هتزنر', ['پلن', 'لوکیشن', 'vCPU', 'RAM (گیگابایت)', 'فضای دیسک (گیگابایت)', 'ترافیک ماهانهٔ مشمول (TB)', 'ساعتی (تومان / ساعت)', 'ماهانه (تومان / ماه)', 'هزینهٔ ترافیک مازاد (تومان / TB ده‌دهی)'],
    sorted.map(offer => `<tr><th scope="row">${planLink(offer)}${offer.diskType ? `<small class="tariff-disk-type">نوع دیسک <bdi>${escapeHtml(offer.diskType)}</bdi></small>` : ''}</th>${locationCell(offer)}` +
      `<td>${number.format(offer.vcpu)}</td><td>${number.format(offer.memoryMb / 1024)}</td><td>${number.format(offer.diskGb)}</td>` +
      `<td><bdi>${formatTrafficTb(offer.includedTrafficBytes ?? offer.trafficOverage?.includedBytes)}</bdi></td>` +
      `<td>${displayPrice(offer.hourly, 'hourly')}</td><td>${displayPrice(offer.monthly, 'monthly')}</td><td>${offer.trafficOverage ? `<bdi>${toman(offer.trafficOverage.perTbRial)}</bdi>` : 'نرخ معتبر در دسترس نیست'}</td></tr>`).join(''), true)
    : `<p role="status">${countryFiltered ? 'سروری برای این کشور یافت نشد' : meta?.status === 'pricing_unavailable' ? 'نرخ ارز معتبر برای محاسبهٔ قیمت هتزنر در دسترس نیست؛ پس از تأیید نرخ تازه، قیمت‌ها نمایش داده می‌شوند.' : hetzner === null ? 'دریافت تعرفهٔ هتزنر موقتاً ممکن نیست.' : 'در حال حاضر پلن قابل سفارش هتزنر برای نمایش وجود ندارد.'}</p>`
  const iranSection = `<section id="iran-server"><h3>تعرفه سرور ایران (ماهانه)</h3>` +
    (iran ? `<p>هر TB برابر ۱٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ بایت است. نرخ‌ها ${iran.tax === 'included' ? 'شامل مالیات هستند' : 'بدون مالیات هستند'}.</p>`
      : '<p>تعرفهٔ تأییدشدهٔ آسیاتک هنوز منتشر نشده است. برای خرید سرور ایران، وضعیت عرضه و قیمت را از پشتیبانی استعلام کنید.</p>') +
    wrapTable('نرخ واحد منابع سرور ایران', ['منبع', 'واحد', 'قیمت ماهانه'], iranRows) +
    '<p>این ارقام نرخ واحد منابع‌اند. هزینهٔ دیسک، IPv4 و بسته‌های اضافی در قیمت کامل ماشین مشخص می‌شود.</p>' +
    '<p class="tariff-inquiry"><a href="/tickets">استعلام قیمت سرور ایران از پشتیبانی</a> برای ثبت تیکت، وارد حساب خود شوید.</p></section>'
  const date = (value: string) => `<time datetime="${escapeHtml(value)}">${tariffTime.format(new Date(value))}</time>`
  const time = meta ? `<p class="tariff-freshness">بررسی قیمت: ${date(meta.checkedAt)} (تهران).${meta.catalogUpdatedAt ? ` تعرفهٔ کاتالوگ: ${date(meta.catalogUpdatedAt)}.` : ''}${meta.fxUpdatedAt ? ` نرخ ارز: ${date(meta.fxUpdatedAt)}.` : ''} این جدول پیش‌فاکتور قطعی نیست.</p>` : ''
  const cheapest = sortHetznerOffers(hetzner ?? [], period)[0]
  const amount = cheapest?.[period]
  const affordable = cheapest && amount != null ? `<p>کم‌هزینه‌ترین گزینهٔ همین فهرست برای پرداخت ${period === 'hourly' ? 'ساعتی' : 'ماهانه'}: <bdi>${escapeHtml(cheapest.name)}</bdi> در <bdi>${escapeHtml(publicLocation(cheapest))}</bdi>، <bdi>${toman(amount)}</bdi>. این مقایسه فقط بین پلن‌های منتشرشدهٔ پارس سرور است.</p>` : ''
  return { iran: scope === 'all' ? iranSection : '', hetzner: `<p>مبالغ جدول شامل مالیاتِ تنظیم‌شده‌اند. قیمت و موجودی پلن هنگام سفارش دوباره بررسی می‌شوند.</p><p>${indicativeOverageNotice}</p>${time}${affordable}${hetznerTable}` }
}

export function renderHomeTariffs(...args: Parameters<typeof renderTariffSections>) {
  const [iran, hetzner, meta] = args
  const sections = renderTariffSections(...args)
  const state = meta ? `<script id="home-prices-state" type="application/json">${JSON.stringify({ iran, hetzner, meta }).replace(/</g, '\\u003c')}</script>` : ''
  return sections.iran +
    `<section id="hetzner-server" aria-labelledby="hetzner-tariff-heading"><div class="tariff-header"><h3 id="hetzner-tariff-heading">${hetznerTariffHeading}</h3></div><div class="tariff-body">${sections.hetzner}</div></section>${state}`
}
