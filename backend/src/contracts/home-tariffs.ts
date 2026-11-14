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
  id: string; name: string; location: string; vcpu: number; memoryMb: number; diskGb: number; diskType?: string; trafficGb: number | null
  hourly: number | null; monthly: number | null
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const number = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 3 })
const toman = (rial: number) => `${number.format(rial / 10)} تومان`
const inquiry = 'استعلام قیمت'
export const iranRateMaximum = 1_000_000_000_000
const wrapTable = (caption: string, headings: string[], body: string) => `<div class="tariff-scroll" tabindex="0" role="region" aria-label="${caption}"><table><caption>${caption}</caption><thead><tr>${headings.map(heading => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`

export function renderHomeTariffs(iran: IranTariffs | null, hetzner: PublicHetznerOffer[] | null) {
  const iranRows = (Object.keys(iranResources) as IranResource[]).map(key => {
    const rate = iran?.rates[key]
    const unit = key === 'cpu' ? '۱ هسته vCPU' : key === 'ram' ? '۱ گیگابایت RAM' : iran ? `۱ ${escapeHtml(iran.trafficUnit)}` : 'واحد پس از تأیید قرارداد'
    return `<tr><th scope="row">${iranResources[key]}</th><td><bdi>${unit}</bdi></td><td>${rate == null ? inquiry : toman(rate)}</td></tr>`
  }).join('')
  const buy = (offer: PublicHetznerOffer, period: 'hourly' | 'monthly') => {
    const price = offer[period]
    if (price === null) return 'عرضه نمی‌شود'
    const label = period === 'hourly' ? 'ساعتی' : 'ماهانه'
    return `<bdi>${toman(price)}</bdi><br><a href="/servers/create?offer=${encodeURIComponent(offer.id)}&amp;period=${period}" aria-label="خرید ${escapeHtml(offer.name)} ${label} در ${escapeHtml(offer.location)}">انتخاب ${label}</a>`
  }
  const hetznerTable = hetzner?.length ? wrapTable('پلن‌های قابل سفارش هتزنر', ['پلن', 'موقعیت', 'vCPU', 'RAM', 'دیسک', 'ترافیک مشمول', 'هر ساعت', 'هر ماه'],
    hetzner.map(offer => `<tr><th scope="row"><bdi>${escapeHtml(offer.name)}</bdi></th><td><bdi>${escapeHtml(offer.location)}</bdi></td>` +
      `<td>${number.format(offer.vcpu)}</td><td>${number.format(offer.memoryMb / 1024)} گیگابایت</td><td>${number.format(offer.diskGb)} گیگابایت${offer.diskType ? ` <bdi>${escapeHtml(offer.diskType)}</bdi>` : ''}</td>` +
      `<td>${offer.trafficGb === null ? 'اعلام نشده' : `${number.format(offer.trafficGb)} گیگابایت`}</td><td>${buy(offer, 'hourly')}</td><td>${buy(offer, 'monthly')}</td></tr>`).join(''))
    : `<p role="status">${hetzner === null ? 'دریافت تعرفهٔ هتزنر موقتاً ممکن نیست.' : 'در حال حاضر پلن قابل سفارش هتزنر برای نمایش وجود ندارد.'}</p>`
  return `<section id="iran-server"><h3>تعرفه سرور ایران (ماهانه)</h3>` +
    (iran ? `<p>${iran.trafficUnit === 'TB' ? 'هر TB برابر ۱٬۰۰۰ GB است.' : 'هر TiB برابر ۱٬۰۲۴ GiB است.'} نرخ‌ها ${iran.tax === 'included' ? 'شامل مالیات هستند' : 'بدون مالیات هستند'}.</p>`
      : '<p>تعرفهٔ تأییدشدهٔ آسیاتک هنوز منتشر نشده است. برای خرید سرور ایران، وضعیت عرضه و قیمت را از پشتیبانی استعلام کنید.</p>') +
    wrapTable('نرخ واحد منابع سرور ایران', ['منبع', 'واحد', 'قیمت ماهانه'], iranRows) +
    '<p>این ارقام نرخ واحد منابع‌اند. هزینهٔ دیسک، IPv4 و بسته‌های اضافی در قیمت کامل ماشین مشخص می‌شود.</p></section>' +
    `<section id="hetzner-server"><h3>تعرفه سرور هتزنر</h3><p>مبالغ به تومان و برای دورهٔ ستون هستند. قیمت هنگام ثبت سفارش دوباره بررسی می‌شود.</p>${hetznerTable}</section>`
}
