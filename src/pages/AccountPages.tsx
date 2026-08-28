import { Clock3, Laptop, LogOut, MapPin, Save, ShieldCheck, UserRound, UserRoundCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { ProfileGuard } from '../components/ui/States'
import { Badge } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'

export function ProfilePage() {
  const [legal, setLegal] = useState(false)
  const { showToast } = useToast()

  const save = (event: FormEvent) => {
    event.preventDefault()
    showToast('اطلاعات پروفایل به صورت آزمایشی ذخیره شد.')
  }

  return (
    <form className="page-stack" onSubmit={save}>
      <PageHeader title="پروفایل کاربری 👤" subtitle="اطلاعات شخصی و حقوقی خود را مدیریت کنید." icon={<UserRound />} />
      <Card>
        <SectionHeading title="اطلاعات شخصی" icon={<UserRoundCheck size={20} />} />
        <div className="form-grid form-grid--two">
          <Input label="نام" placeholder="نام خود را وارد کنید" />
          <Input label="نام خانوادگی" placeholder="نام خانوادگی خود را وارد کنید" />
          <Input label="شماره همراه" type="tel" inputMode="numeric" placeholder="09xxxxxxxxx" />
          <div className="identity-field">
            <Input label="کد ملی" inputMode="numeric" placeholder="کد ملی خود را وارد کنید" hint="کد ملی باید متعلق به صاحب شماره همراه باشد." />
            <Button variant="secondary" size="sm" type="button">احراز هویت</Button>
          </div>
          <Input label="ایمیل" type="email" placeholder="example@email.com" />
        </div>
      </Card>
      <Card>
        <SectionHeading title="اطلاعات حقوقی" />
        <div className="legal-row">
          <div><p>اطلاعات شرکت و شخصیت حقوقی خود را اضافه کنید.</p><Toggle checked={legal} onChange={setLegal} label={legal ? 'فعال' : 'غیرفعال'} /></div>
        </div>
        {legal ? (
          <div className="form-grid form-grid--two form-reveal">
            <Input label="نام شرکت" placeholder="نام رسمی شرکت" />
            <Input label="شناسه ملی" placeholder="شناسه ملی شرکت" />
            <Input label="شماره ثبت" placeholder="شماره ثبت" />
            <Input label="کد اقتصادی" placeholder="کد اقتصادی" />
          </div>
        ) : null}
      </Card>
      <div className="page-footer-actions"><Button type="submit" icon={<Save size={18} />}>ذخیره تغییرات</Button></div>
    </form>
  )
}

export function SessionsPage() {
  const { showToast } = useToast()
  return (
    <div className="page-stack">
      <PageHeader title="نشست‌های فعال 🔐" subtitle="مدیریت دستگاه‌ها و نشست‌های فعال خود" icon={<ShieldCheck />} />
      <div className="metrics-grid metrics-grid--two metrics-grid--narrow">
        <MetricCard label="نشست فعال" value="۱" icon={Laptop} accent="green" />
        <MetricCard label="آخرین فعالیت" value="همین حالا" icon={Clock3} />
      </div>
      <Card>
        <SectionHeading title="دستگاه‌های متصل" />
        <article className="session-card">
          <span className="session-card__icon"><Laptop size={32} /></span>
          <div className="session-card__copy">
            <div><strong>Chrome روی Windows</strong><Badge tone="success">نشست فعلی</Badge></div>
            <p><MapPin size={15} /> Asia/Tehran <span>·</span> آخرین فعالیت: همین حالا</p>
          </div>
          <Button variant="secondary" icon={<LogOut size={17} />} onClick={() => showToast('نشست دیگری برای خروج وجود ندارد.')}>خروج از سایر نشست‌ها</Button>
        </article>
      </Card>
    </div>
  )
}

export function SettingsPage() {
  const [timezone, setTimezone] = useState('Asia/Tehran')
  const { showToast } = useToast()

  return (
    <div className="page-stack">
      <PageHeader title="تنظیمات" subtitle="ترجیحات نمایش و تنظیمات حساب کاربری" />
      <Card className="settings-card">
        <SectionHeading title="منطقه زمانی" icon={<MapPin size={20} />} />
        <Select label="منطقه زمانی" value={timezone} onChange={(event) => setTimezone(event.target.value)} hint="تمام تاریخ‌ها و زمان‌ها بر اساس این منطقه زمانی نمایش داده می‌شوند.">
          <option value="auto">تشخیص خودکار</option><option>Asia/Tehran</option><option>Asia/Dubai</option><option>Europe/Berlin</option><option>Europe/London</option><option>Europe/Amsterdam</option><option>Europe/Istanbul</option><option>America/New_York</option><option>America/Chicago</option><option>America/Los_Angeles</option><option>Asia/Kolkata</option><option>Asia/Shanghai</option><option>Asia/Tokyo</option><option>Australia/Sydney</option><option>UTC</option>
        </Select>
        <Button icon={<Save size={18} />} onClick={() => showToast(`منطقه زمانی روی ${timezone} ذخیره شد.`)}>ذخیره</Button>
      </Card>
    </div>
  )
}

export function ProfileGuardPage() {
  return (
    <div className="page-stack">
      <PageHeader title="حالت محافظت‌شده" subtitle="الگوی مشترک برای بخش‌هایی که نیازمند تکمیل پروفایل هستند." />
      <div className="guard-page"><ProfileGuard /></div>
    </div>
  )
}
