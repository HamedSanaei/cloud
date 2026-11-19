import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/FormControls'
import { useApiQuery } from '../hooks/useApiQuery'
import { apiGet, apiPost } from '../lib/apiClient'
import { markupTomanToRial, maxHetznerFixedRial, maxHetznerMarkupPercent } from '../../backend/src/contracts/hetzner-margin'

interface Margin { markupPercent: string; markupFixedRial: number }
interface Settings extends Margin {
  enabled: boolean
  taxPercent: string
  version: string
  updatedBy: string | null
  history: Array<{ id: string; actorId: string | null; createdAt: string; before: Margin | null; after: Margin | null }>
}
interface Preview {
  id: string
  name: string
  location: string
  prices: Array<{
    period: string; providerCurrency: string; providerAmountCents: number; providerRial: number; fxRate: string; fxAt: string
    beforeRial: number | null; afterRial: number; markupRial: number; effectivePercent: number | null; taxRial: number
  }>
}

const path = '/admin/settings/hetzner-margin'
const number = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 8 })
const toman = (rial: number) => number.format(rial / 10) + ' تومان'
const percent = (value: string | number) => number.format(Number(value)) + '٪'
const time = (value: string) => new Date(value).toLocaleString('fa-IR')
const describeMargin = (rule: Margin) => `${percent(rule.markupPercent)} + ${toman(rule.markupFixedRial)}`
const load = async () => (await apiGet<{ data: Settings }>(path)).data

export function SystemHetznerMargin() {
  const query = useApiQuery(load)
  const [saved, setSaved] = useState(false)
  return <Card>
    <h2>تنظیم سود سرورهای هتزنر</h2>
    {saved && <p role="status">تنظیم سود ذخیره شد.</p>}
    {query.loading ? <p role="status">در حال دریافت تنظیمات…</p>
      : query.error || !query.data ? <><p role="alert">{query.error ?? 'تنظیمات دریافت نشد.'}</p><Button onClick={query.refetch}>دریافت دوباره</Button></>
      : <MarginForm key={query.data.version} rule={query.data} reload={query.refetch} onSaved={() => { setSaved(true); query.refetch() }} />}
  </Card>
}

function MarginForm({ rule, reload, onSaved }: { rule: Settings; reload: () => void; onSaved: () => void }) {
  const [markupPercent, setPercent] = useState(rule.markupPercent)
  const [fixedToman, setFixedToman] = useState(String(rule.markupFixedRial / 10))
  const [preview, setPreview] = useState<Preview[] | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState('')
  const markupFixedRial = markupTomanToRial(fixedToman)
  const valid = /^\d{1,4}(?:\.\d{1,4})?$/.test(markupPercent) && Number(markupPercent) <= maxHetznerMarkupPercent && markupFixedRial !== null
  const changed = Number(markupPercent) !== Number(rule.markupPercent) || markupFixedRial !== rule.markupFixedRial
  async function submit(mode: 'preview' | 'save') {
    if (!valid || markupFixedRial === null || busy) return
    if (mode === 'save' && (!preview || !changed || !window.confirm('این سود برای قیمت‌های جدید و تمدیدهای آینده ثبت شود؟'))) return
    setBusy(mode)
    setError('')
    try {
      const input = { markupPercent, markupFixedRial, version: rule.version }
      if (mode === 'preview') {
        setPreview(null)
        setPreview((await apiPost<{ data: Preview[] }>(path + '/preview', input)).data)
      } else {
        const payload = { ...input, confirm: true }
        const { data } = await apiPost<{ data: { proof: string } }>('/admin/settings/authorize', { action: 'pricing.hetzner_margin', payload })
        await apiPost(path, { ...payload, proof: data.proof })
        onSaved()
      }
    } catch (failure) {
      setPreview(null)
      setError(failure instanceof Error ? failure.message : 'عملیات تکمیل نشد.')
    } finally { setBusy(null) }
  }
  return <>
    <p>سود فعلی {describeMargin(rule)} است. آخرین تغییر در {time(rule.version)} {rule.updatedBy && <>توسط <bdi>{rule.updatedBy}</bdi></>} ثبت شده است.</p>
    <p>هزینهٔ ارائه‌دهنده به ریال تبدیل می‌شود، مبلغ ثابت به آن اضافه می‌شود، درصد سود روی مجموع اعمال می‌شود و سپس مالیات فعلی ({percent(rule.taxPercent)}) به مبلغ اضافه می‌شود.</p>
    <p>مبلغ دورهٔ ماهانهٔ پرداخت‌شده و پیش‌فاکتور معتبر قبلی حفظ می‌شود. سود جدید در قیمت‌های آینده اعمال می‌شود.</p>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void submit('preview') }}>
      <Input label="درصد سود" type="number" min={0} max={maxHetznerMarkupPercent} step="0.0001" required disabled={!!busy}
        value={markupPercent} onChange={event => { setPercent(event.target.value); setPreview(null); setError('') }} />
      <Input label="سود ثابت هر دوره (تومان)" type="number" min={0} max={maxHetznerFixedRial / 10} step="0.1" required disabled={!!busy}
        value={fixedToman} onChange={event => { setFixedToman(event.target.value); setPreview(null); setError('') }} />
      <div className="inline-actions">
        <Button type="submit" variant="secondary" disabled={!!busy || !valid}>{busy === 'preview' ? 'در حال محاسبه…' : 'مقایسهٔ قیمت قبل و بعد'}</Button>
        <Button type="button" disabled={!!busy || !valid || !preview || !changed} onClick={() => void submit('save')}>{busy === 'save' ? 'در حال ذخیره…' : 'تأیید و ذخیرهٔ سود'}</Button>
        <Button type="button" variant="secondary" disabled={!!busy} onClick={reload}>تازه‌سازی تنظیمات</Button>
      </div>
    </form>
    {error && <p role="alert">{error}</p>}
    {preview && <section aria-label="پیش‌نمایش قیمت هتزنر">
      <h3>پیش‌نمایش قیمت هتزنر</h3>
      {preview.length === 0 && <p>{rule.enabled ? 'در حال حاضر پلن قابل عرضه‌ای برای محاسبه وجود ندارد.' : 'قیمت‌گذاری هتزنر غیرفعال است.'}</p>}
      {preview.map(offer => <article key={offer.id}>
        <h4><bdi>{offer.name} · {offer.location}</bdi></h4>
        {offer.prices.map(price => <div key={price.period}>
          <strong>{price.period === 'hourly' ? 'ساعتی' : 'ماهانه'}</strong>
          <p>هزینهٔ خرید <bdi>{number.format(price.providerAmountCents / 100)} {price.providerCurrency}</bdi> ({toman(price.providerRial)}).
            نرخ تبدیل {number.format(Number(price.fxRate))} ریال در {time(price.fxAt)}.</p>
          <p>قیمت فعلی {price.beforeRial === null ? 'ناموجود' : toman(price.beforeRial)} · قیمت پیشنهادی {toman(price.afterRial)} · مالیات {toman(price.taxRial)}</p>
          <p>سود پیش از مالیات {toman(price.markupRial)}{price.effectivePercent !== null && <> ({percent(price.effectivePercent)} نسبت به هزینهٔ خرید)</>}</p>
        </div>)}
      </article>)}
    </section>}
    <h3>تاریخچهٔ تغییرات سود</h3>
    {rule.history.length ? <ul>{rule.history.map(entry => <li key={entry.id}>
      {time(entry.createdAt)} · <bdi>{entry.actorId ?? 'سیستم'}</bdi>
      {entry.before && entry.after ? <> · قبلی {describeMargin(entry.before)} · جدید {describeMargin(entry.after)}</> : <> · تغییر ثبت‌شده در نسخهٔ قبلی</>}
    </li>)}</ul> : <p>تغییری ثبت نشده است.</p>}
  </>
}
