import {
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  MapPin,
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
import { checkDomainAvailability, createServer, listWallets, registerDomain } from '../lib/endpoints'
import { formatFaNumber } from '../lib/format'
import { useApiQuery } from '../hooks/useApiQuery'

const serverSteps = ['موقعیت و دیتاسنتر', 'انتخاب منابع', 'سیستم عامل', 'مالی', 'تایید نهایی']

export function CreateServerPage() {
  const [step, setStep] = useState(0)
  const [region, setRegion] = useState('tehran')
  const [plan, setPlan] = useState('standard')
  const [os, setOs] = useState('ubuntu')
  const [name, setName] = useState('server-01')
  const [walletId, setWalletId] = useState('')
  const [billingPeriod, setBillingPeriod] = useState('ماهانه')
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const { showToast } = useToast()
  const wallets = useApiQuery(listWallets)

  const next = async () => {
    if (step < serverSteps.length - 1) {
      setStep((value) => value + 1)
      return
    }
    if (!isApiConfigured()) {
      showToast('سرور نمونه با موفقیت به صف ساخت اضافه شد.')
      navigate('/servers')
      return
    }
    setSubmitting(true)
    try {
      await createServer({ name, region, plan, os, walletId: walletId || undefined, billingPeriod })
      showToast('سرور با موفقیت به صف ساخت اضافه شد.')
      navigate('/servers')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ایجاد سرور ناموفق بود.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-stack wizard-page">
      <PageHeader
        title="ایجاد سرور جدید"
        subtitle="سرور جدید خود را با تنظیمات دلخواه ایجاد کنید."
        icon={<Server />}
        actions={<LinkButton to="/servers" variant="secondary" icon={<ArrowLeft size={18} />}>بازگشت</LinkButton>}
      />
      <Card padding="none" className="wizard-card">
        <div className="wizard-card__header">
          <SectionHeading title={serverSteps[step]} />
          <p>{['منطقه جغرافیایی و دیتاسنتر را انتخاب کنید.', 'توان پردازشی مورد نیاز خود را مشخص کنید.', 'سیستم عامل مناسب را انتخاب کنید.', 'کیف پول و دوره پرداخت را انتخاب کنید.', 'جزئیات سفارش را بررسی و تایید کنید.'][step]}</p>
        </div>
        <Stepper steps={serverSteps} current={step} />
        <div className="wizard-card__content">
          {step === 0 ? (
            <div className="choice-grid choice-grid--three">
              {[
                { value: 'tehran', title: 'تهران', subtitle: 'دیتاسنتر برج میلاد', ping: 'کمترین تاخیر', icon: MapPin },
                { value: 'germany', title: 'آلمان', subtitle: 'Frankfurt am Main', ping: 'اروپا', icon: Globe2 },
                { value: 'turkey', title: 'ترکیه', subtitle: 'Istanbul', ping: 'خاورمیانه', icon: Network },
              ].map(({ value, title, subtitle, ping, icon: Icon }) => (
                <button type="button" className={`choice-card ${region === value ? 'choice-card--selected' : ''}`} onClick={() => setRegion(value)} key={value}>
                  <Icon size={26} /><strong>{title}</strong><span>{subtitle}</span><small>{ping}</small>
                </button>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="choice-grid choice-grid--three">
              {[
                { value: 'starter', title: 'اقتصادی', cpu: '۱ هسته', ram: '۱ GB', disk: '۲۵ GB', price: '۲۹۰ هزار تومان' },
                { value: 'standard', title: 'استاندارد', cpu: '۲ هسته', ram: '۴ GB', disk: '۸۰ GB', price: '۷۹۰ هزار تومان' },
                { value: 'pro', title: 'حرفه‌ای', cpu: '۴ هسته', ram: '۸ GB', disk: '۱۶۰ GB', price: '۱٬۴۹۰ هزار تومان' },
              ].map((item) => (
                <button type="button" className={`choice-card plan-card ${plan === item.value ? 'choice-card--selected' : ''}`} onClick={() => setPlan(item.value)} key={item.value}>
                  <Cpu size={26} /><strong>{item.title}</strong><span>{item.cpu} · {item.ram}</span><span><Database size={14} /> {item.disk}</span><small>{item.price} / ماه</small>
                </button>
              ))}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="choice-grid choice-grid--four">
              {[
                ['ubuntu', 'Ubuntu', '24.04 LTS'], ['debian', 'Debian', '12 Bookworm'], ['rocky', 'Rocky Linux', '9.4'], ['windows', 'Windows Server', '2022'],
              ].map(([value, title, version]) => (
                <button type="button" className={`choice-card os-card ${os === value ? 'choice-card--selected' : ''}`} onClick={() => setOs(value)} key={value}>
                  <HardDrive size={26} /><strong>{title}</strong><span>{version}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="wizard-form">
              <Select label="کیف پول پرداخت" value={walletId} onChange={(event) => setWalletId(event.target.value)}>
                <option value="">کیف پول پیش‌فرض — ۰ تومان</option>
                {(wallets.data ?? []).map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>{wallet.name}</option>
                ))}
              </Select>
              <Select label="دوره پرداخت" value={billingPeriod} onChange={(event) => setBillingPeriod(event.target.value)}><option>ماهانه</option><option>سه‌ماهه</option><option>سالانه</option></Select>
              <div className="info-box"><WalletCards size={20} /><span>{isApiConfigured() ? 'مبلغ سفارش از کیف پول انتخاب‌شده کسر خواهد شد.' : 'موجودی فعلی برای ثبت سفارش کافی نیست. این نسخه نمایشی از پرداخت عبور می‌کند.'}</span></div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="review-grid">
              <Input label="نام سرور" value={name} onChange={(event) => setName(event.target.value)} />
              <div className="review-list">
                <ReviewRow label="موقعیت" value={region === 'tehran' ? 'تهران' : region === 'germany' ? 'آلمان' : 'ترکیه'} />
                <ReviewRow label="منابع" value={plan === 'standard' ? 'استاندارد — ۲ CPU / ۴ GB' : plan === 'starter' ? 'اقتصادی — ۱ CPU / ۱ GB' : 'حرفه‌ای — ۴ CPU / ۸ GB'} />
                <ReviewRow label="سیستم عامل" value={os.toUpperCase()} />
                <ReviewRow label="پرداخت" value={billingPeriod} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="wizard-card__footer">
          <Button variant="secondary" disabled={step === 0 || submitting} onClick={() => setStep((value) => Math.max(0, value - 1))}>مرحله قبل</Button>
          <Button icon={step === serverSteps.length - 1 ? <CheckCircle2 size={18} /> : undefined} disabled={submitting} onClick={next}>{submitting ? 'در حال ایجاد...' : step === serverSteps.length - 1 ? 'تایید و ایجاد سرور' : 'مرحله بعد'}</Button>
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
