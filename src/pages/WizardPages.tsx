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

const serverSteps = ['موقعیت و دیتاسنتر', 'انتخاب منابع', 'سیستم عامل', 'مالی', 'تایید نهایی']

export function CreateServerPage() {
  const [step, setStep] = useState(0)
  const [region, setRegion] = useState('tehran')
  const [plan, setPlan] = useState('standard')
  const [os, setOs] = useState('ubuntu')
  const [name, setName] = useState('server-01')
  const navigate = useNavigate()
  const { showToast } = useToast()

  const next = () => {
    if (step < serverSteps.length - 1) setStep((value) => value + 1)
    else {
      showToast('سرور نمونه با موفقیت به صف ساخت اضافه شد.')
      navigate('/servers')
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
              <Select label="کیف پول پرداخت"><option>کیف پول پیش‌فرض — ۰ تومان</option></Select>
              <Select label="دوره پرداخت"><option>ماهانه</option><option>سه‌ماهه</option><option>سالانه</option></Select>
              <div className="info-box"><WalletCards size={20} /><span>موجودی فعلی برای ثبت سفارش کافی نیست. این نسخه نمایشی از پرداخت عبور می‌کند.</span></div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="review-grid">
              <Input label="نام سرور" value={name} onChange={(event) => setName(event.target.value)} />
              <div className="review-list">
                <ReviewRow label="موقعیت" value={region === 'tehran' ? 'تهران' : region === 'germany' ? 'آلمان' : 'ترکیه'} />
                <ReviewRow label="منابع" value={plan === 'standard' ? 'استاندارد — ۲ CPU / ۴ GB' : plan === 'starter' ? 'اقتصادی — ۱ CPU / ۱ GB' : 'حرفه‌ای — ۴ CPU / ۸ GB'} />
                <ReviewRow label="سیستم عامل" value={os.toUpperCase()} />
                <ReviewRow label="پرداخت" value="ماهانه" />
              </div>
            </div>
          ) : null}
        </div>
        <div className="wizard-card__footer">
          <Button variant="secondary" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>مرحله قبل</Button>
          <Button icon={step === serverSteps.length - 1 ? <CheckCircle2 size={18} /> : undefined} onClick={next}>{step === serverSteps.length - 1 ? 'تایید و ایجاد سرور' : 'مرحله بعد'}</Button>
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
  const [period, setPeriod] = useState('1')
  const navigate = useNavigate()
  const { showToast } = useToast()
  const normalizedDomain = useMemo(() => domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''), [domain])

  const finish = () => {
    if (step < 2) setStep((value) => value + 1)
    else {
      showToast('سفارش دامنه نمونه ثبت شد.')
      navigate('/domains')
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
                <Button icon={<Search size={18} />} disabled={!normalizedDomain.includes('.')} onClick={() => setSearched(true)}>بررسی</Button>
              </div>
              {searched ? (
                <div className="domain-result"><CheckCircle2 size={24} /><div><strong>{normalizedDomain}</strong><span>این دامنه برای ثبت در دسترس است.</span></div><strong>۹۹۰ هزار تومان / سال</strong></div>
              ) : <p className="muted-copy">پسوند دامنه را نیز وارد کنید؛ برای نمونه example.com</p>}
            </div>
          ) : null}
          {step === 1 ? (
            <div className="wizard-form">
              <Select label="دوره ثبت" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">یک سال</option><option value="2">دو سال</option><option value="5">پنج سال</option></Select>
              <Select label="کیف پول پرداخت"><option>کیف پول پیش‌فرض — ۰ تومان</option></Select>
              <div className="info-box"><WalletCards size={20} /><span>در نسخه واقعی، مبلغ از کیف پول انتخاب‌شده کسر خواهد شد.</span></div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="review-list review-list--centered">
              <ReviewRow label="دامنه" value={normalizedDomain || 'example.com'} />
              <ReviewRow label="دوره ثبت" value={`${period} سال`} />
              <ReviewRow label="هزینه نهایی" value="۹۹۰ هزار تومان" />
              <ReviewRow label="پرداخت" value="کیف پول پیش‌فرض" />
            </div>
          ) : null}
        </div>
        <div className="wizard-card__footer"><Button variant="secondary" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>مرحله قبل</Button><Button onClick={finish} disabled={step === 0 && !searched}>{step === 2 ? 'تایید و ثبت دامنه' : 'مرحله بعد'}</Button></div>
      </Card>
    </div>
  )
}
