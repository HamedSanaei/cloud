import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, LockKeyhole, Mail, Phone, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import {
  getGoogleLoginUrl,
  resendChallenge,
  resetPassword,
  startEmailLogin,
  startPasswordRecovery,
  startPhoneLogin,
  startRegistration,
  verifyChallenge,
  verifyRecoveryCode,
  verifyTotpChallenge,
  type AuthChallenge,
  type AuthSession,
} from '../lib/auth'

type AuthIntent = 'login' | 'register' | 'forgot'
type LoginMethod = 'email' | 'phone'

function BrandMark() {
  return <span className="public-brand-mark" aria-hidden="true"><i /><i /><i /></span>
}

function AuthBrandPanel() {
  return (
    <aside className="auth-brand-panel" aria-label="مزایای سرورهاب">
      <div>
        <h2>زیرساخت شما، همیشه در دسترس</h2>
        <p>مدیریت آسان سرورها، دامنه‌ها و سرویس‌های ابری در یک پنل یکپارچه</p>
      </div>
      <div className="auth-server-stack" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <div className="auth-server-line" key={item}>
            <span className="auth-server-icon"><Server size={20} /></span>
            <span className="auth-skeleton"><i /><i /></span>
            <b />
          </div>
        ))}
      </div>
      <p className="auth-reassurance">امنیت بالا <span>•</span> پشتیبانی ۲۴ ساعته <span>•</span> پایداری سرویس</p>
      <small>CLOUD CONTROL PANEL</small>
    </aside>
  )
}

function GoogleIcon() {
  return <span className="google-g" aria-hidden="true">G</span>
}

function OtpField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="auth-field auth-otp-field">
      <span>کد تأیید ۶ رقمی</span>
      <input
        autoFocus
        autoComplete="one-time-code"
        dir="ltr"
        disabled={disabled}
        inputMode="numeric"
        maxLength={6}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="— — — — — —"
        value={value}
      />
    </label>
  )
}

export function AuthPage({ intent }: { intent: AuthIntent }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { acceptSession } = useAuth()
  const [method, setMethod] = useState<LoginMethod>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [mobile, setMobile] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null)
  const [code, setCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [countdown, setCountdown] = useState(0)

  const returnTo = useMemo(() => {
    const from = (location.state as { from?: string } | null)?.from
    return from?.startsWith('/') ? from : '/dashboard'
  }, [location.state])

  useEffect(() => {
    setCountdown(challenge?.resendAfter ?? 0)
  }, [challenge])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [countdown])

  function complete(session: AuthSession) {
    acceptSession(session)
    setSuccess(true)
    window.setTimeout(() => navigate(returnTo, { replace: true }), 700)
  }

  async function submitEntry(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (intent === 'register' && password !== confirmPassword) {
      setError('تکرار رمز عبور با رمز اصلی یکسان نیست.')
      return
    }
    setBusy(true)
    try {
      if (intent === 'register') setChallenge(await startRegistration({ email, password, firstName, lastName }))
      else if (intent === 'forgot') setChallenge(await startPasswordRecovery(email))
      else if (method === 'phone') setChallenge(await startPhoneLogin(mobile))
      else setChallenge(await startEmailLogin(email, password))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'انجام عملیات ناموفق بود.')
    } finally {
      setBusy(false)
    }
  }

  async function submitChallenge(event: FormEvent) {
    event.preventDefault()
    if (!challenge) return
    setBusy(true)
    setError('')
    try {
      if (intent === 'forgot') {
        if (password !== confirmPassword) throw new Error('تکرار رمز عبور با رمز اصلی یکسان نیست.')
        await resetPassword(challenge.challengeToken, code, password)
        setSuccess(true)
        window.setTimeout(() => navigate('/login', { replace: true }), 1000)
      } else if (challenge.challengeType === 'totp' && recoveryMode) {
        complete(await verifyRecoveryCode(challenge.challengeToken, recoveryCode))
      } else if (challenge.challengeType === 'totp') {
        complete(await verifyTotpChallenge(challenge.challengeToken, code))
      } else {
        complete(await verifyChallenge(challenge.challengeToken, code))
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'کد تأیید معتبر نیست.')
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (!challenge || countdown > 0) return
    setBusy(true)
    setError('')
    try {
      setChallenge(await resendChallenge(challenge.challengeToken))
      setCode('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ارسال مجدد ناموفق بود.')
    } finally {
      setBusy(false)
    }
  }

  async function googleLogin() {
    setBusy(true)
    setError('')
    try {
      window.location.assign(await getGoogleLoginUrl(returnTo))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ورود با گوگل در دسترس نیست.')
      setBusy(false)
    }
  }

  const title = challenge
    ? challenge.challengeType === 'totp' ? (recoveryMode ? 'ورود با کد بازیابی' : 'تأیید دومرحله‌ای (2FA)') : intent === 'forgot' ? 'انتخاب رمز عبور جدید' : challenge.challengeType === 'sms' ? 'تأیید شماره موبایل' : 'تأیید آدرس ایمیل'
    : intent === 'register' ? 'ساخت حساب کاربری' : intent === 'forgot' ? 'بازیابی رمز عبور' : 'ورود به حساب کاربری'

  const subtitle = challenge
    ? challenge.challengeType === 'totp' ? 'کد ۶ رقمی برنامه احراز هویت خود را وارد کنید.' : `کد ارسال‌شده به ${challenge.destination} را وارد کنید.`
    : intent === 'register' ? 'برای شروع مدیریت زیرساخت، حساب امن خود را بسازید.' : intent === 'forgot' ? 'لینک بازیابی را با یک کد امن به ایمیل شما می‌فرستیم.' : 'برای مدیریت سرویس‌های ابری وارد حساب خود شوید.'

  return (
    <main className="auth-page" dir="rtl">
      <div className="auth-layout">
        <AuthBrandPanel />
        <section className="auth-card">
          <header className="auth-card-header">
            <Link className="public-logo" to="/"><BrandMark /><strong>سرورهاب</strong></Link>
            <span><ShieldCheck size={17} /> ورود امن</span>
          </header>

          {success ? (
            <div className="auth-success" role="status">
              <span><Check size={34} /></span>
              <h1>{intent === 'forgot' ? 'رمز عبور تغییر کرد' : 'ورود موفقیت‌آمیز'}</h1>
              <p>{intent === 'forgot' ? 'اکنون می‌توانید با رمز جدید وارد شوید.' : 'در حال انتقال شما به پنل مدیریت…'}</p>
            </div>
          ) : (
            <>
              <div className="auth-heading">
                <h1>
                  <span className="auth-title-desktop">{title}</span>
                  <span className="auth-title-mobile">{!challenge && intent === 'login' ? 'خوش آمدید 👋' : title}</span>
                </h1>
                <p>
                  <span className="auth-title-desktop">{subtitle}</span>
                  <span className="auth-title-mobile">{!challenge && intent === 'login' ? 'برای ورود به پنل، اطلاعات حساب خود را وارد کنید.' : subtitle}</span>
                </p>
              </div>
              {!challenge ? (
                <form className="auth-form" onSubmit={submitEntry}>
                  {intent === 'login' && (
                    <div className="auth-method-tabs" role="tablist">
                      <button className={method === 'email' ? 'active' : ''} onClick={() => setMethod('email')} role="tab" type="button"><Mail size={17} /> ایمیل و رمز عبور</button>
                      <button className={method === 'phone' ? 'active' : ''} onClick={() => setMethod('phone')} role="tab" type="button"><Phone size={17} /> شماره همراه</button>
                    </div>
                  )}
                  {intent === 'register' && (
                    <div className="auth-name-row">
                      <label className="auth-field"><span>نام</span><input autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} value={firstName} /></label>
                      <label className="auth-field"><span>نام خانوادگی</span><input autoComplete="family-name" onChange={(e) => setLastName(e.target.value)} value={lastName} /></label>
                    </div>
                  )}
                  {method === 'phone' && intent === 'login' ? (
                    <label className="auth-field"><span>شماره همراه</span><input autoComplete="tel" dir="ltr" inputMode="tel" onChange={(e) => setMobile(e.target.value)} placeholder="09123456789" required value={mobile} /></label>
                  ) : (
                    <label className="auth-field"><span>آدرس ایمیل</span><input autoComplete="email" dir="ltr" onChange={(e) => setEmail(e.target.value)} placeholder="example@email.com" required type="email" value={email} /></label>
                  )}
                  {intent !== 'forgot' && method === 'email' && (
                    <label className="auth-field"><span>رمز عبور</span><span className="password-input"><input autoComplete={intent === 'register' ? 'new-password' : 'current-password'} dir="ltr" minLength={8} onChange={(e) => setPassword(e.target.value)} required type={showPassword ? 'text' : 'password'} value={password} /><button aria-label="نمایش رمز عبور" onClick={() => setShowPassword((value) => !value)} type="button">{showPassword ? <EyeOff /> : <Eye />}</button></span></label>
                  )}
                  {intent === 'register' && (
                    <label className="auth-field"><span>تکرار رمز عبور</span><input autoComplete="new-password" dir="ltr" minLength={8} onChange={(e) => setConfirmPassword(e.target.value)} required type={showPassword ? 'text' : 'password'} value={confirmPassword} /></label>
                  )}
                  {intent === 'login' && method === 'email' && <Link className="auth-text-link" to="/forgot-password">رمز عبور را فراموش کرده‌اید؟</Link>}
                  {error && <p className="auth-error" role="alert">{error}</p>}
                  <button className="auth-primary-button" disabled={busy} type="submit">{busy ? <RefreshCw className="spin" size={19} /> : intent === 'register' ? 'ساخت حساب' : intent === 'forgot' ? 'ارسال کد بازیابی' : method === 'phone' ? 'ارسال کد پیامکی' : 'ورود به حساب'}</button>
                  {intent === 'login' && method === 'email' && <button className="auth-google-button" disabled={busy} onClick={googleLogin} type="button"><GoogleIcon /> ورود با حساب گوگل</button>}
                  <p className="auth-switch-copy">{intent === 'register' ? <>حساب دارید؟ <Link to="/login">وارد شوید</Link></> : intent === 'login' ? <>حساب ندارید؟ <Link to="/register">ثبت‌نام کنید</Link></> : <Link to="/login"><ArrowLeft size={15} /> بازگشت به ورود</Link>}</p>
                </form>
              ) : (
                <form className="auth-form" onSubmit={submitChallenge}>
                  {challenge.challengeType === 'totp' && !recoveryMode && <div className="auth-security-hint"><KeyRound size={18} /> Google Authenticator یا برنامه مشابه</div>}
                  {challenge.challengeType === 'totp' && recoveryMode ? (
                    <label className="auth-field"><span>کد بازیابی یک‌بارمصرف</span><input autoFocus dir="ltr" onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())} placeholder="ABCDE-12345" required value={recoveryCode} /></label>
                  ) : <OtpField disabled={busy} onChange={setCode} value={code} />}
                  {intent === 'forgot' && (
                    <>
                      <label className="auth-field"><span>رمز عبور جدید</span><input autoComplete="new-password" dir="ltr" minLength={8} onChange={(e) => setPassword(e.target.value)} required type="password" value={password} /></label>
                      <label className="auth-field"><span>تکرار رمز جدید</span><input autoComplete="new-password" dir="ltr" minLength={8} onChange={(e) => setConfirmPassword(e.target.value)} required type="password" value={confirmPassword} /></label>
                    </>
                  )}
                  {challenge.developmentCode && <p className="auth-dev-code">حالت توسعه — کد: <b dir="ltr">{challenge.developmentCode}</b></p>}
                  {error && <p className="auth-error" role="alert">{error}</p>}
                  <button className="auth-primary-button" disabled={busy || (!recoveryMode && code.length !== 6)} type="submit">{busy ? <RefreshCw className="spin" size={19} /> : intent === 'forgot' ? 'ثبت رمز عبور جدید' : 'تأیید هویت و ورود'}</button>
                  {challenge.challengeType === 'totp' ? (
                    <button className="auth-secondary-button" onClick={() => { setRecoveryMode((value) => !value); setError('') }} type="button"><LockKeyhole size={17} /> {recoveryMode ? 'استفاده از کد برنامه' : 'استفاده از کد بازیابی'}</button>
                  ) : (
                    <button className="auth-resend" disabled={busy || countdown > 0} onClick={resend} type="button"><RefreshCw size={16} /> {countdown > 0 ? `ارسال مجدد تا ${countdown} ثانیه دیگر` : 'ارسال مجدد کد'}</button>
                  )}
                  <button className="auth-back" onClick={() => { setChallenge(null); setCode(''); setError('') }} type="button">اصلاح اطلاعات ورود</button>
                </form>
              )}
            </>
          )}
          <footer className="auth-card-footer">با ادامه، قوانین استفاده و حریم خصوصی را می‌پذیرید.</footer>
        </section>
      </div>
    </main>
  )
}

export function GoogleCallbackPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState('')
  useEffect(() => {
    if (params.get('success') !== '1') {
      setError('ورود با گوگل تکمیل نشد.')
      return
    }
    void refresh().then(() => {
      const target = params.get('redirectTo')
      navigate(target?.startsWith('/') ? target : '/dashboard', { replace: true })
    }).catch(() => setError('نشست ورود با گوگل قابل تأیید نیست.'))
  }, [navigate, params, refresh])
  return <main className="auth-page"><div className="route-loader"><span />{error ? <p>{error} <Link to="/login">بازگشت</Link></p> : <p>در حال تکمیل ورود با گوگل…</p>}</div></main>
}
