import {
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  Network,
  Search,
  Server,
  WalletCards,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, LinkButton } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { Input, Select } from '../components/ui/FormControls'
import { PageHeader } from '../components/ui/PageHeader'
import { Stepper } from '../components/ui/Stepper'
import { useToast } from '../components/ui/Toast'
import { isApiConfigured } from '../lib/apiClient'
import { checkDomainAvailability, createServer, getStorefrontCatalog, listWallets, registerDomain } from '../lib/endpoints'
import { formatFaNumber } from '../lib/format'
import { useApiQuery } from '../hooks/useApiQuery'
import type { BillingPeriod } from '../lib/types'

const serverSteps = ['دیتاسنتر و موقعیت', 'دوره پرداخت', 'نوع و منابع سرور', 'سیستم عامل', 'کیف پول', 'تایید نهایی']
const periodLabels: Record<BillingPeriod, string> = { hourly: 'ساعتی', daily: 'روزانه', monthly: 'ماهانه' }
const periodOrder: BillingPeriod[] = ['hourly', 'daily', 'monthly']
const priceLabel = (totalRial: number) => `${formatFaNumber(totalRial / 10)} تومان`

export function CreateServerPage() {
  const [step, setStep] = useState(0)
  const [providerId, setProviderId] = useState('')
  const [location, setLocation] = useState('')
  const [offerId, setOfferId] = useState('')
  const [os, setOs] = useState('')
  const [name, setName] = useState('')
  const [walletId, setWalletId] = useState('')
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod | ''>('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const navigate = useNavigate()
  const { showToast } = useToast()
  const catalog = useApiQuery(getStorefrontCatalog)
  const wallets = useApiQuery(listWallets)
  const datacenters = catalog.data?.datacenters ?? []
  const provider = datacenters.find((item) => item.id === providerId)
  const selectedLocation = provider?.locations.find((item) => item.code === location)
  const locationOffers = (catalog.data?.offers ?? []).filter((item) => item.provider === providerId && item.location === location)
  const periods = periodOrder.filter((period) => provider?.billingPeriods.includes(period) && locationOffers.some((item) => item.prices.some((price) => price.period === period)))
  const visibleOffers = locationOffers.filter((item) => item.prices.some((price) => price.period === billingPeriod))
  const offer = visibleOffers.find((item) => item.id === offerId)
  const selectedOs = offer?.operatingSystems.find((item) => item.id === os)
  const price = offer?.prices.find((item) => item.period === billingPeriod)
  const wallet = wallets.data?.find((item) => item.id === walletId)
  const catalogReady = isApiConfigured() && !catalog.loading && !catalog.error && !!catalog.data
  const locationValid = !!provider && !!selectedLocation
  const periodValid = billingPeriod !== '' && periods.includes(billingPeriod)
  const offerValid = !!offer && !!price
  const walletValid = !wallets.loading && !wallets.error && !!wallet
  const nameValid = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$/.test(name.trim())
  const allValid = catalogReady && locationValid && periodValid && offerValid && !!selectedOs && walletValid && nameValid
  const canContinue = catalogReady && [
    locationValid,
    locationValid && periodValid,
    locationValid && periodValid && offerValid,
    locationValid && periodValid && offerValid && !!selectedOs,
    locationValid && periodValid && offerValid && !!selectedOs && walletValid,
    allValid,
  ][step]
  const resetOffer = () => { setOfferId(''); setOs(''); setWalletId(''); setSubmitError('') }
  const reloadCatalog = () => {
    setProviderId(''); setLocation(''); setBillingPeriod(''); resetOffer(); setStep(0); catalog.refetch()
  }
  const next = async () => {
    if (submitting || !canContinue) return
    if (step < serverSteps.length - 1) { setStep((value) => value + 1); return }
    if (!allValid || !billingPeriod || !offer || !selectedOs || !wallet) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await createServer({ name: name.trim(), offerId: offer.id, os: selectedOs.id, walletId: wallet.id, billingPeriod })
      showToast('سرور با موفقیت به صف ساخت اضافه شد.')
      navigate('/servers')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'ایجاد سرور ناموفق بود.')
    } finally {
      setSubmitting(false)
    }
  }
  const locationLabel = selectedLocation ? [selectedLocation.city, selectedLocation.country, selectedLocation.code].filter(Boolean).join(' · ') : 'انتخاب نشده'
  const catalogState = catalog.loading ? 'در حال دریافت دیتاسنترها و قیمت‌های واقعی…' : catalog.error || (!datacenters.length ? 'در حال حاضر دیتاسنتر فعالی برای سفارش موجود نیست.' : '')

  return (
    <div className="page-stack wizard-page server-storefront" dir="rtl">
      <PageHeader title="ایجاد سرور جدید" subtitle="دیتاسنتر، دوره پرداخت و منابع را از کاتالوگ زنده انتخاب کنید." icon={<Server />}
        actions={<LinkButton to="/servers" variant="secondary" icon={<ArrowLeft size={18} />}>بازگشت</LinkButton>} />
      <Card padding="none" className="wizard-card">
        <div className="wizard-card__header">
          <SectionHeading title={serverSteps[step]} />
          <p>{['دیتاسنتر فعال و سپس موقعیت واقعی سرور را انتخاب کنید.', 'دوره پرداخت را پیش از انتخاب منابع مشخص کنید.', 'فقط محصولات قابل سفارش در موقعیت و دوره انتخاب‌شده نمایش داده می‌شوند.', 'سیستم عامل قابل نصب روی محصول انتخابی را مشخص کنید.', 'کیف پول پرداخت سفارش را انتخاب کنید.', 'نام سرور و جزئیات سفارش را بررسی و تایید کنید.'][step]}</p>
        </div>
        <Stepper steps={serverSteps} current={step} />
        <div className="wizard-card__content" aria-busy={catalog.loading || submitting}>
          {catalogState ? (
            <div className="storefront-state" role={catalog.error ? 'alert' : 'status'}>
              <Server size={30} /><p>{catalogState}</p>
              {!catalog.loading ? <Button variant="secondary" onClick={reloadCatalog}>تلاش دوباره</Button> : null}
            </div>
          ) : <>
            {step === 0 ? <div className="storefront-stack">
              <div className="choice-grid storefront-grid">
                {datacenters.map((item) => (
                  <button type="button" aria-pressed={providerId === item.id} className={`choice-card provider-card ${providerId === item.id ? 'choice-card--selected' : ''}`} key={item.id}
                    onClick={() => { if (providerId !== item.id) { setProviderId(item.id); setLocation(''); setBillingPeriod(''); resetOffer() } }}>
                    <span className="provider-card__logo"><img src={item.logo} alt={item.name} /></span>
                    <strong>{item.name}</strong><span>{formatFaNumber(item.locations.length)} موقعیت قابل سفارش</span>
                  </button>
                ))}
              </div>
              {provider ? <Select label="موقعیت سرور" value={location} onChange={(event) => { setLocation(event.target.value); setBillingPeriod(''); resetOffer() }}>
                <option value="">موقعیت را انتخاب کنید</option>
                {provider.locations.map((item) => <option key={item.code} value={item.code}>{[item.city, item.country, item.code].filter(Boolean).join(' · ')}</option>)}
              </Select> : <p className="storefront-hint">برای مشاهده موقعیت‌ها، ابتدا یک دیتاسنتر انتخاب کنید.</p>}
              {provider && !provider.locations.length ? <div className="storefront-state"><p>موقعیت قابل سفارشی برای این دیتاسنتر موجود نیست.</p><Button variant="secondary" onClick={reloadCatalog}>دریافت دوباره کاتالوگ</Button></div> : null}
            </div> : null}
            {step === 1 ? <div className="storefront-stack">
              <div className="choice-grid storefront-grid">{periods.map((period) => (
                <button type="button" key={period} aria-pressed={billingPeriod === period} className={`choice-card ${billingPeriod === period ? 'choice-card--selected' : ''}`}
                  onClick={() => { if (billingPeriod !== period) { setBillingPeriod(period); resetOffer() } }}>
                  <WalletCards size={26} /><strong>{periodLabels[period]}</strong>
                  <span>{period === 'daily' ? 'پرداخت برای ۲۴ ساعت' : period === 'hourly' ? 'پرداخت برای هر ساعت' : 'محصول با دوره ماهانه واقعی'}</span>
                </button>
              ))}</div>
              {!periods.length ? <div className="storefront-state"><p>برای این موقعیت، دوره پرداخت قابل سفارشی موجود نیست.</p><Button variant="secondary" onClick={reloadCatalog}>دریافت دوباره کاتالوگ</Button></div> : null}
            </div> : null}
            {step === 2 ? <div className="storefront-stack">
              <div className="choice-grid storefront-grid">{visibleOffers.map((item) => {
                const itemPrice = item.prices.find((entry) => entry.period === billingPeriod)!
                return <button type="button" key={item.id} aria-pressed={offerId === item.id} className={`choice-card plan-card ${offerId === item.id ? 'choice-card--selected' : ''}`}
                  onClick={() => { if (offerId !== item.id) { resetOffer(); setOfferId(item.id) } }}>
                  <Cpu size={26} /><strong dir="auto">{item.name}</strong><span>{item.category === 'cloud' ? 'سرور ابری' : item.category === 'vps' ? 'سرور مجازی' : item.category}</span>
                  <span>{formatFaNumber(item.vcpu)} هسته · {formatFaNumber(item.memoryMb / 1024)} گیگابایت حافظه</span>
                  <span><Database size={14} />{formatFaNumber(item.diskGb)} گیگابایت دیسک</span>
                  {item.trafficGb !== null ? <span>{formatFaNumber(item.trafficGb)} گیگابایت ترافیک</span> : null}
                  <small>{priceLabel(itemPrice.totalRial)} / {billingPeriod ? periodLabels[billingPeriod] : ''}</small>
                </button>
              })}</div>
              {!visibleOffers.length ? <div className="storefront-state"><p>محصول قابل سفارشی با این انتخاب‌ها موجود نیست.</p><Button variant="secondary" onClick={reloadCatalog}>دریافت دوباره کاتالوگ</Button></div> : null}
            </div> : null}
            {step === 3 ? <div className="storefront-stack">
              <div className="choice-grid storefront-grid">{offer?.operatingSystems.map((item) => (
                <button type="button" key={item.id} aria-pressed={os === item.id} className={`choice-card os-card ${os === item.id ? 'choice-card--selected' : ''}`} onClick={() => { setOs(item.id); setSubmitError('') }}>
                  <HardDrive size={26} /><strong dir="auto">{item.label || item.id}</strong>{item.family ? <span dir="auto">{item.family}</span> : null}
                </button>
              ))}</div>
              {!offer?.operatingSystems.length ? <div className="storefront-state"><p>سیستم عامل قابل نصبی برای این محصول موجود نیست؛ محصول دیگری انتخاب کنید.</p><Button variant="secondary" onClick={reloadCatalog}>دریافت دوباره کاتالوگ</Button></div> : null}
            </div> : null}
            {step === 4 ? <div className="storefront-stack">
              {wallets.loading ? <div className="storefront-state" role="status">در حال دریافت کیف پول‌ها…</div> : wallets.error ? <div className="storefront-state" role="alert"><p>{wallets.error}</p><Button variant="secondary" onClick={wallets.refetch}>تلاش دوباره</Button></div> : !wallets.data?.length ? <div className="storefront-state"><p>برای ثبت سفارش ابتدا یک کیف پول ایجاد و شارژ کنید.</p><LinkButton to="/wallet" variant="secondary">مدیریت کیف پول‌ها</LinkButton><Button variant="secondary" onClick={wallets.refetch}>دریافت دوباره کیف پول‌ها</Button></div> :
                <Select label="کیف پول پرداخت" value={walletId} onChange={(event) => { setWalletId(event.target.value); setSubmitError('') }}>
                  <option value="">کیف پول را انتخاب کنید</option>
                  {wallets.data.map((item) => <option key={item.id} value={item.id}>{item.name} — {formatFaNumber(item.balance)} تومان</option>)}
                </Select>}
              <div className="info-box"><WalletCards size={20} /><span>{price ? `مبلغ ${priceLabel(price.totalRial)} برای دوره ${billingPeriod ? periodLabels[billingPeriod] : ''} از کیف پول انتخابی پرداخت می‌شود. موجودی هنگام ثبت سفارش بررسی خواهد شد.` : 'ابتدا محصول و دوره پرداخت معتبر انتخاب کنید.'}</span></div>
            </div> : null}
            {step === 5 ? <div className="review-grid">
              <Input label="نام سرور" value={name} disabled={submitting} maxLength={63} dir="ltr" placeholder="my-server" onChange={(event) => { setName(event.target.value); setSubmitError('') }}
                hint="۳ تا ۶۳ نویسه انگلیسی، عدد یا خط تیره؛ ابتدا و انتها حرف یا عدد باشد." error={name && !nameValid ? 'نام سرور معتبر نیست.' : undefined} />
              <div className="review-list">
                <ReviewRow label="دیتاسنتر" value={provider?.name ?? 'انتخاب نشده'} />
                <ReviewRow label="موقعیت" value={locationLabel} />
                <ReviewRow label="دوره پرداخت" value={billingPeriod ? periodLabels[billingPeriod] : 'انتخاب نشده'} />
                <ReviewRow label="محصول" value={offer?.name ?? 'انتخاب نشده'} />
                <ReviewRow label="منابع" value={offer ? `${formatFaNumber(offer.vcpu)} هسته / ${formatFaNumber(offer.memoryMb / 1024)} GB حافظه / ${formatFaNumber(offer.diskGb)} GB دیسک` : 'انتخاب نشده'} />
                <ReviewRow label="سیستم عامل" value={selectedOs?.label || selectedOs?.id || 'انتخاب نشده'} />
                <ReviewRow label="کیف پول" value={wallet?.name ?? 'انتخاب نشده'} />
                <ReviewRow label="مبلغ پرداخت" value={price ? priceLabel(price.totalRial) : 'انتخاب نشده'} />
              </div>
              {!locationValid || !periodValid || !offerValid || !selectedOs || !walletValid ? <div className="storefront-state" role="alert"><p>انتخاب‌های سفارش معتبر نیست؛ کاتالوگ را دوباره دریافت و مراحل را تکمیل کنید.</p><Button variant="secondary" onClick={reloadCatalog}>انتخاب دوباره</Button></div> : null}
              {submitError ? <div className="storefront-state" role="alert"><p>{submitError}</p><Button variant="secondary" onClick={reloadCatalog}>به‌روزرسانی کاتالوگ و انتخاب دوباره</Button></div> : null}
            </div> : null}
          </>}
        </div>
        <div className="wizard-card__footer">
          <Button variant="secondary" disabled={step === 0 || submitting} onClick={() => setStep((value) => Math.max(0, value - 1))}>مرحله قبل</Button>
          <Button icon={step === serverSteps.length - 1 ? <CheckCircle2 size={18} /> : undefined} disabled={submitting || !canContinue} onClick={next}>{submitting ? 'در حال ایجاد...' : step === serverSteps.length - 1 ? 'تایید و ایجاد سرور' : 'مرحله بعد'}</Button>
        </div>
      </Card>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

const domainSteps = ['انتخاب دامنه', 'مالی', 'تایید نهایی']

export function RegisterDomainPage() {
  const [step, setStep] = useState(0)
  const [domain, setDomain] = useState('')
  const [searched, setSearched] = useState(false)
  const [checking, setChecking] = useState(false)
  const [available, setAvailable] = useState(true)
  const [price, setPrice] = useState('۹۹۰ هزار تومان')
  const [period, setPeriod] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const { showToast } = useToast()
  const normalizedDomain = useMemo(() => domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''), [domain])
  const wallets = useApiQuery(listWallets)
  const [walletId, setWalletId] = useState('')

  const checkAvailability = async () => {
    setChecking(true)
    try {
      const result = await checkDomainAvailability(normalizedDomain)
      setAvailable(result.available)
      setSearched(true)
      if (result.available && result.pricePerYear > 0) {
        setPrice(`${formatFaNumber(result.pricePerYear)} تومان / سال`)
      }
      if (!result.available) showToast('این دامنه برای ثبت در دسترس نیست.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'بررسی دامنه ناموفق بود.')
    } finally {
      setChecking(false)
    }
  }

  const finish = async () => {
    if (step < 2) {
      setStep((value) => value + 1)
      return
    }
    if (!isApiConfigured()) {
      showToast('سفارش دامنه نمونه ثبت شد.')
      navigate('/domains')
      return
    }
    setSubmitting(true)
    try {
      await registerDomain({ domain: normalizedDomain, periodYears: Number(period), walletId: walletId || undefined })
      showToast('سفارش دامنه با موفقیت ثبت شد.')
      navigate('/domains')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ثبت دامنه ناموفق بود.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-stack wizard-page">
      <PageHeader title="ثبت دامنه جدید" subtitle="دامنه مورد نظر خود را جستجو و ثبت کنید." icon={<Network />} actions={<LinkButton to="/domains" variant="secondary" icon={<ArrowLeft size={18} />}>بازگشت به دامنه‌ها</LinkButton>} />
      <Card padding="none" className="wizard-card">
        <div className="wizard-card__header"><SectionHeading title={domainSteps[step]} /><p>{step === 0 ? 'نام دامنه را جستجو و دوره ثبت را انتخاب کنید.' : step === 1 ? 'روش پرداخت و دوره ثبت را بررسی کنید.' : 'جزئیات سفارش دامنه را تایید کنید.'}</p></div>
        <Stepper steps={domainSteps} current={step} />
        <div className="wizard-card__content">
          {step === 0 ? (
            <div className="domain-search-step">
              <div className="domain-search-row">
                <Input label="جستجوی دامنه" value={domain} onChange={(event) => { setDomain(event.target.value); setSearched(false) }} placeholder="example.com" />
                <Button icon={<Search size={18} />} disabled={!normalizedDomain.includes('.') || checking} onClick={checkAvailability}>{checking ? 'در حال بررسی...' : 'بررسی'}</Button>
              </div>
              {searched ? (
                available ? (
                  <div className="domain-result"><CheckCircle2 size={24} /><div><strong>{normalizedDomain}</strong><span>این دامنه برای ثبت در دسترس است.</span></div><strong>{price}</strong></div>
                ) : (
                  <p className="muted-copy">این دامنه در دسترس نیست؛ نام دیگری را امتحان کنید.</p>
                )
              ) : <p className="muted-copy">پسوند دامنه را نیز وارد کنید؛ برای نمونه example.com</p>}
            </div>
          ) : null}
          {step === 1 ? (
            <div className="wizard-form">
              <Select label="دوره ثبت" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">یک سال</option><option value="2">دو سال</option><option value="5">پنج سال</option></Select>
              <Select label="کیف پول پرداخت" value={walletId} onChange={(event) => setWalletId(event.target.value)}>
                <option value="">کیف پول پیش‌فرض — ۰ تومان</option>
                {(wallets.data ?? []).map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>{wallet.name}</option>
                ))}
              </Select>
              <div className="info-box"><WalletCards size={20} /><span>{isApiConfigured() ? 'مبلغ سفارش از کیف پول انتخاب‌شده کسر خواهد شد.' : 'در نسخه واقعی، مبلغ از کیف پول انتخاب‌شده کسر خواهد شد.'}</span></div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="review-list review-list--centered">
              <ReviewRow label="دامنه" value={normalizedDomain || 'example.com'} />
              <ReviewRow label="دوره ثبت" value={`${period} سال`} />
              <ReviewRow label="هزینه نهایی" value={price} />
              <ReviewRow label="پرداخت" value="کیف پول پیش‌فرض" />
            </div>
          ) : null}
        </div>
        <div className="wizard-card__footer"><Button variant="secondary" disabled={step === 0 || submitting} onClick={() => setStep((value) => Math.max(0, value - 1))}>مرحله قبل</Button><Button onClick={finish} disabled={(step === 0 && !searched) || submitting}>{submitting ? 'در حال ثبت...' : step === 2 ? 'تایید و ثبت دامنه' : 'مرحله بعد'}</Button></div>
      </Card>
    </div>
  )
}
