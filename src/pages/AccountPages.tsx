import { Clock3, Laptop, LogOut, MapPin, Save, ShieldCheck, UserRound, UserRoundCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { Card, SectionHeading } from '../components/ui/Card'
import { Input, Select, Toggle } from '../components/ui/FormControls'
import { MetricCard } from '../components/ui/MetricCard'
import { PageHeader } from '../components/ui/PageHeader'
import { LoadingState, ProfileGuard, QueryError } from '../components/ui/States'
import { Badge, Table } from '../components/ui/Table'
import { useToast } from '../components/ui/Toast'
import { useApiQuery } from '../hooks/useApiQuery'
import { isApiConfigured } from '../lib/apiClient'
import { getProfile, listSessions, revokeOtherSessions, updateProfile, updateTimezone, verifyNationalCode } from '../lib/endpoints'
import { formatCount } from '../lib/format'

export function ProfilePage() {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [mobile, setMobile] = useState('')
  const [nationalCode, setNationalCode] = useState('')
  const [email, setEmail] = useState('')
  const [legal, setLegal] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [registrationNumber, setRegistrationNumber] = useState('')
  const [economicCode, setEconomicCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const { showToast } = useToast()
  const profile = useApiQuery(getProfile)

  useEffect(() => {
    if (profile.data) {
      setFirstName(profile.data.firstName ?? '')
      setLastName(profile.data.lastName ?? '')
      setMobile(profile.data.mobile ?? '')
      setNationalCode(profile.data.nationalCode ?? '')
      setEmail(profile.data.email ?? '')
      setLegal(profile.data.legalEnabled ?? false)
      setCompanyName(profile.data.companyName ?? '')
      setNationalId(profile.data.nationalId ?? '')
      setRegistrationNumber(profile.data.registrationNumber ?? '')
      setEconomicCode(profile.data.economicCode ?? '')
    }
  }, [profile.data])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!isApiConfigured()) {
      showToast('اطلاعات پروفایل به صورت آزمایشی ذخیره شد.')
      return
    }
    setSaving(true)
    try {
      await updateProfile({ firstName, lastName, mobile, nationalCode, email, legalEnabled: legal, companyName, nationalId, registrationNumber, economicCode })
      profile.refetch()
      showToast('اطلاعات پروفایل ذخیره شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ذخیره پروفایل ناموفق بود.')
    } finally {
      setSaving(false)
    }
  }

  const verify = async () => {
    if (!isApiConfigured()) {
      showToast('در حالت نمایشی، احراز هویت انجام نمی‌شود.')
      return
    }
    if (!nationalCode || !mobile) {
      showToast('کد ملی و شماره همراه را وارد کنید.')
      return
    }
    setVerifying(true)
    try {
      await verifyNationalCode({ nationalCode, mobile })
      showToast('احراز هویت با موفقیت انجام شد.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'احراز هویت ناموفق بود.')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <form className="page-stack" onSubmit={save}>
      <PageHeader title="پروفایل کاربری 👤" subtitle="اطلاعات شخصی و حقوقی خود را مدیریت کنید." icon={<UserRound />} />
      {profile.loading && isApiConfigured() ? (
        <Card><LoadingState label="در حال دریافت پروفایل..." /></Card>
      ) : profile.error ? (
        <Card><QueryError message={profile.error} onRetry={profile.refetch} /></Card>
      ) : (
        <>
          <Card>
            <SectionHeading title="اطلاعات شخصی" icon={<UserRoundCheck size={20} />} />
            <div className="form-grid form-grid--two">
              <Input label="نام" placeholder="نام خود را وارد کنید" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
              <Input label="نام خانوادگی" placeholder="نام خانوادگی خود را وارد کنید" value={lastName} onChange={(event) => setLastName(event.target.value)} />
              <Input label="شماره همراه" type="tel" inputMode="numeric" placeholder="09xxxxxxxxx" value={mobile} onChange={(event) => setMobile(event.target.value)} />
              <div className="identity-field">
                <Input label="کد ملی" inputMode="numeric" placeholder="کد ملی خود را وارد کنید" hint="کد ملی باید متعلق به صاحب شماره همراه باشد." value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} />
                <Button variant="secondary" size="sm" type="button" disabled={verifying} onClick={verify}>{verifying ? 'در حال بررسی...' : 'احراز هویت'}</Button>
              </div>
              <Input label="ایمیل" type="email" placeholder="example@email.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
          </Card>
          <Card>
            <SectionHeading title="اطلاعات حقوقی" />
            <div className="legal-row">
              <div><p>اطلاعات شرکت و شخصیت حقوقی خود را اضافه کنید.</p><Toggle checked={legal} onChange={setLegal} label={legal ? 'فعال' : 'غیرفعال'} /></div>
            </div>
            {legal ? (
              <div className="form-grid form-grid--two form-reveal">
                <Input label="نام شرکت" placeholder="نام رسمی شرکت" value={companyName} onChange={(event) => setCompanyName(event.target.value)} />
                <Input label="شناسه ملی" placeholder="شناسه ملی شرکت" value={nationalId} onChange={(event) => setNationalId(event.target.value)} />
                <Input label="شماره ثبت" placeholder="شماره ثبت" value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} />
                <Input label="کد اقتصادی" placeholder="کد اقتصادی" value={economicCode} onChange={(event) => setEconomicCode(event.target.value)} />
              </div>
            ) : null}
          </Card>
        </>
      )}
      <div className="page-footer-actions"><Button type="submit" icon={<Save size={18} />} disabled={saving}>{saving ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</Button></div>
    </form>
  )
}

export function SessionsPage() {
  const { showToast } = useToast()
  const sessions = useApiQuery(listSessions)
  const [revoking, setRevoking] = useState(false)

  const items = sessions.data ?? []
  const activeCurrent = items.find((item) => item.current) ?? items[0]

  const revoke = async () => {
    if (!isApiConfigured()) {
      showToast('نشست دیگری برای خروج وجود ندارد.')
      return
    }
    setRevoking(true)
    try {
      await revokeOtherSessions()
      sessions.refetch()
      showToast('از سایر نشست‌ها خارج شدید.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'خروج از نشست‌ها ناموفق بود.')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="نشست‌های فعال 🔐" subtitle="مدیریت دستگاه‌ها و نشست‌های فعال خود" icon={<ShieldCheck />} />
      <div className="metrics-grid metrics-grid--two metrics-grid--narrow">
        <MetricCard label="نشست فعال" value={formatCount(items.length || 1)} icon={Laptop} accent="green" />
        <MetricCard label="آخرین فعالیت" value={activeCurrent?.lastActivity ?? 'همین حالا'} icon={Clock3} />
      </div>
      <Card>
        <SectionHeading title="دستگاه‌های متصل" />
        {sessions.loading ? (
          <LoadingState label="در حال دریافت نشست‌ها..." />
        ) : sessions.error ? (
          <QueryError message={sessions.error} onRetry={sessions.refetch} />
        ) : !items.length ? (
          <Table headers={['دستگاه', 'موقعیت', 'وضعیت']}>
            <tr className="table-empty"><td colSpan={3}>نشستی یافت نشد</td></tr>
          </Table>
        ) : (
          items.map((session) => (
            <article className="session-card" key={session.id}>
              <span className="session-card__icon"><Laptop size={32} /></span>
              <div className="session-card__copy">
                <div><strong>{session.device}</strong>{session.current ? <Badge tone="success">نشست فعلی</Badge> : null}</div>
                <p><MapPin size={15} /> {session.location} <span>·</span> آخرین فعالیت: {session.lastActivity}</p>
              </div>
              {session.current ? (
                <Button variant="secondary" icon={<LogOut size={17} />} disabled={revoking} onClick={revoke}>{revoking ? 'در حال خروج...' : 'خروج از سایر نشست‌ها'}</Button>
              ) : null}
            </article>
          ))
        )}
      </Card>
    </div>
  )
}

export function SettingsPage() {
  const [timezone, setTimezone] = useState(() => {
    try {
      return localStorage.getItem('cloud-timezone') ?? 'Asia/Tehran'
    } catch {
      return 'Asia/Tehran'
    }
  })
  const [saving, setSaving] = useState(false)
  const { showToast } = useToast()

  const saveTimezone = async () => {
    setSaving(true)
    try {
      await updateTimezone(timezone)
      try {
        localStorage.setItem('cloud-timezone', timezone)
      } catch {
        // ignore
      }
      showToast(`منطقه زمانی روی ${timezone} ذخیره شد.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ذخیره منطقه زمانی ناموفق بود.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="تنظیمات" subtitle="ترجیحات نمایش و تنظیمات حساب کاربری" />
      <Card className="settings-card">
        <SectionHeading title="منطقه زمانی" icon={<MapPin size={20} />} />
        <Select label="منطقه زمانی" value={timezone} onChange={(event) => setTimezone(event.target.value)} hint="تمام تاریخ‌ها و زمان‌ها بر اساس این منطقه زمانی نمایش داده می‌شوند.">
          <option value="auto">تشخیص خودکار</option><option>Asia/Tehran</option><option>Asia/Dubai</option><option>Europe/Berlin</option><option>Europe/London</option><option>Europe/Amsterdam</option><option>Europe/Istanbul</option><option>America/New_York</option><option>America/Chicago</option><option>America/Los_Angeles</option><option>Asia/Kolkata</option><option>Asia/Shanghai</option><option>Asia/Tokyo</option><option>Australia/Sydney</option><option>UTC</option>
        </Select>
        <Button icon={<Save size={18} />} disabled={saving} onClick={saveTimezone}>{saving ? 'در حال ذخیره...' : 'ذخیره'}</Button>
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
