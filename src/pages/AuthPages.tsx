import { safeReturnPath } from '../../backend/src/contracts/return-path'
import { invalidIranMobile, normalizeIranMobile } from '../../backend/src/contracts/iran-mobile'
import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, LockKeyhole, Mail, Phone, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { BRAND_NAME, BrandMark } from '../components/Brand'
import { OtpField } from '../components/OtpField'
import { EmailSpamHint } from '../components/EmailSpamHint'
import { ApiError } from '../lib/apiClient'
import { toFaDigits } from '../lib/format'
import { readSmsCode } from '../lib/webOtp'
import {
  getGoogleLoginUrl,
  resendChallenge,
  resetPassword,
  startEmailLogin,
  startPasswordRecovery,
  startPhonePasswordRecovery,
  startPhoneLogin,
  startPhonePasswordLogin,
  startPhoneRegistration,
  startRegistration,
  verifyChallenge,
  verifyRecoveryCode,
  verifyTotpChallenge,
  type AuthChallenge,
  type AuthSession,
} from '../lib/auth'

type AuthIntent = 'login' | 'register' | 'forgot'
type LoginMethod = 'email' | 'phone'
const methods: LoginMethod[] = ['phone', 'email']

function AuthBrandPanel() {
  return (
    <aside className="auth-brand-panel" aria-label={`مزایای ${BRAND_NAME}`}>
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

export function AuthPage({ intent, adminEntry = false }: { intent: AuthIntent; adminEntry?: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const requestedReturn = params.get('returnTo')
  const passwordReset = intent === 'login' && location.state?.passwordReset === true
  const afterPhoneReset = passwordReset && location.state?.method === 'phone'
  const { acceptSession } = useAuth()
  const [method, setMethod] = useState<LoginMethod>(intent === 'register' || afterPhoneReset || intent === 'forgot' && params.get('method') === 'phone' ? 'phone' : 'email')
  const [phonePassword, setPhonePassword] = useState(afterPhoneReset)
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
  const [mobileError, setMobileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [confirmationError, setConfirmationError] = useState('')
  const [resent, setResent] = useState(false)
  const focusAfterResend = useRef(false)
  const otpInput = useRef<HTMLInputElement>(null)
  const methodTabs = useRef<Partial<Record<LoginMethod, HTMLButtonElement | null>>>({})
  const [success, setSuccess] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [otpLocked, setOtpLocked] = useState(false)
  const [challengeExpired, setChallengeExpired] = useState(false)
  const [receivedSms, setReceivedSms] = useState<{ token: string; code: string; controller: AbortController }>()
  const smsReader = useRef<AbortController | null>(null)
  const sending = useRef<AbortController | null>(null)
  const verification = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      verification.current?.abort()
      sending.current?.abort()
      smsReader.current?.abort()
    }
  }, [intent, location.key])

  const returnTo = useMemo(() => {
    const from = (location.state as { from?: string } | null)?.from
    return adminEntry ? '/admin' : safeReturnPath(from ?? requestedReturn)
  }, [location.state, requestedReturn, adminEntry])

  useEffect(() => {
    setCountdown(challenge?.resendAfter ?? 0)
    setChallengeExpired(false)
    if (!challenge || challenge.challengeType === 'totp' || !Number.isFinite(challenge.expiresIn)) return
    const timer = window.setTimeout(() => setChallengeExpired(true), challenge.expiresIn * 1000)
    return () => window.clearTimeout(timer)
  }, [challenge])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [countdown])

  useEffect(() => {
    if (busy || !focusAfterResend.current) return
    focusAfterResend.current = false
    otpInput.current?.focus()
  }, [busy, challenge])

  function selectMethod(next: LoginMethod) {
    if (next === method) return
    setMethod(next)
    setError('')
    setMobileError('')
    setPasswordError('')
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
  }

  function complete(session: AuthSession) {
    acceptSession(session)
    setSuccess(true)
    window.setTimeout(() => navigate(returnTo, { replace: true }), 700)
  }

  function cancelSmsRead() {
    smsReader.current?.abort()
    smsReader.current = null
    setReceivedSms(undefined)
  }

  async function requestSms(send: () => Promise<AuthChallenge>) {
    cancelSmsRead()
    const controller = new AbortController()
    smsReader.current = controller
    // A fast SMS can arrive before the send endpoint returns the challenge.
    const reading = readSmsCode(controller)
    try {
      const next = await send()
      if (next.challengeType === 'sms' && next.smsAutofill) {
        void reading.then((code) => {
          if (code && !controller.signal.aborted) setReceivedSms({ token: next.challengeToken, code, controller })
        })
      } else controller.abort()
      return next
    } catch (error) {
      controller.abort()
      throw error
    }
  }

  async function submitEntry(event: FormEvent) {
    event.preventDefault()
    if (busy || sending.current) return
    setError('')
    if (method === 'phone' && !normalizeIranMobile(mobile)) {
      setMobileError(invalidIranMobile)
      return
    }
    if (intent === 'login' && method === 'phone' && phonePassword && !password) {
      setPasswordError('رمز عبور را وارد کنید.')
      return
    }
    if (intent === 'register' && method === 'email' && password !== confirmPassword) {
      setError('تکرار رمز عبور با رمز اصلی یکسان نیست.')
      return
    }
    const controller = new AbortController()
    sending.current = controller
    setBusy(true)
    setResent(false)
    try {
      let result: AuthChallenge | AuthSession
      if (intent === 'register' && method === 'phone') result = await startPhoneRegistration({ mobile, firstName, lastName })
      else if (intent === 'register') result = await startRegistration({ email, password, firstName, lastName })
      else if (intent === 'forgot') result = method === 'phone' ? await startPhonePasswordRecovery(mobile) : await startPasswordRecovery(email)
      else if (method === 'phone') result = phonePassword ? await startPhonePasswordLogin(mobile, password) : await requestSms(() => startPhoneLogin(mobile))
      else result = await startEmailLogin(email, password)
      if (controller.signal.aborted) return
      if ('token' in result) complete(result)
      else setChallenge(result)
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'انجام عملیات ناموفق بود.')
    } finally {
      if (sending.current === controller) {
        sending.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }

  async function submitChallenge(event?: FormEvent, submittedCode = code) {
    event?.preventDefault()
    if (!challenge || busy || success || otpLocked || challengeExpired || verification.current) return
    if (!recoveryMode && !/^\d{6}$/.test(submittedCode)) return
    if (intent === 'forgot') {
      const invalidPassword = password.length < 8 || password.length > 200
      const mismatch = password !== confirmPassword
      setPasswordError(invalidPassword ? 'رمز جدید باید ۸ تا ۲۰۰ نویسه داشته باشد.' : '')
      setConfirmationError(mismatch ? 'تکرار رمز عبور با رمز اصلی یکسان نیست.' : '')
      if (invalidPassword || mismatch) return
    }
    cancelSmsRead()
    const controller = new AbortController()
    verification.current = controller
    setBusy(true)
    setError('')
    try {
      if (intent === 'forgot') {
        await resetPassword(challenge.challengeToken, submittedCode, password, recoveryCode || undefined, controller.signal)
        if (!controller.signal.aborted) navigate('/login?returnTo=' + encodeURIComponent(returnTo), { replace: true, state: { passwordReset: true, method } })
      } else if (challenge.challengeType === 'totp' && recoveryMode) {
        complete(await verifyRecoveryCode(challenge.challengeToken, recoveryCode))
      } else if (challenge.challengeType === 'totp') {
        complete(await verifyTotpChallenge(challenge.challengeToken, submittedCode))
      } else {
        const result = await verifyChallenge(challenge.challengeToken, submittedCode, controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        if ('challengeToken' in result) {
          setChallenge(result)
          setCode('')
        } else {
          complete(result)
        }
      }
    } catch (caught) {
      if (controller.signal.aborted || !mounted.current) return
      if (caught instanceof ApiError && caught.status === 410) { setChallengeExpired(true); smsReader.current?.abort() }
      let message = caught instanceof Error ? caught.message : 'کد تأیید معتبر نیست.'
      if (challenge.challengeType === 'sms') {
        setCode('')
        const remaining = caught instanceof ApiError
          ? (caught.body as { details?: { attemptsRemaining?: number } } | null)?.details?.attemptsRemaining : undefined
        if (typeof remaining === 'number') {
          setOtpLocked(remaining === 0)
          message += ` — ${toFaDigits(remaining)} تلاش باقی‌مانده`
        }
      }
      setError(message)
    } finally {
      if (verification.current === controller) verification.current = null
      if (mounted.current) setBusy(false)
    }
  }

  function changeOtp(value: string) {
    cancelSmsRead()
    setCode(value)
    if (intent !== 'forgot' && challenge?.challengeType === 'sms' && value.length === 6) void submitChallenge(undefined, value)
  }

  const fillSmsCode = useEffectEvent((sms: NonNullable<typeof receivedSms>) => {
    if (!sms.controller.signal.aborted && smsReader.current === sms.controller) changeOtp(sms.code)
  })

  useEffect(() => {
    if (!busy && receivedSms && challenge?.challengeType === 'sms' && receivedSms.token === challenge.challengeToken) {
      fillSmsCode(receivedSms)
    }
  }, [busy, challenge, receivedSms])

  async function resend() {
    if (!challenge || countdown > 0 || busy || sending.current || verification.current || otpLocked) return
    const controller = new AbortController()
    sending.current = controller
    setBusy(true)
    setError('')
    setResent(false)
    try {
      const send = () => resendChallenge(challenge.challengeToken)
      const next = challenge.challengeType === 'sms' && intent === 'login' ? await requestSms(send) : await send()
      if (controller.signal.aborted) return
      setChallenge(next)
      setCode('')
      setResent(true)
      focusAfterResend.current = true
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 410) setChallengeExpired(true)
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'ارسال مجدد ناموفق بود.')
    } finally {
      if (sending.current === controller) {
        sending.current = null
        if (mounted.current) setBusy(false)
      }
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
    : intent === 'register' ? 'ساخت حساب کاربری' : intent === 'forgot' ? 'بازیابی رمز عبور' : adminEntry ? 'ورود به پنل مدیریت' : 'ورود به حساب کاربری'

  const subtitle = challenge
    ? challenge.challengeType === 'totp'
      ? 'کد ۶ رقمی برنامه احراز هویت خود را وارد کنید.'
      : intent === 'forgot' && challenge.challengeType === 'email'
        ? <>اگر حسابی با این آدرس وجود داشته باشد، کد بازیابی به <bdi dir="ltr">{challenge.destination}</bdi> ارسال می‌شود.</>
        : <>کد ارسال‌شده به <bdi dir="ltr">{challenge.destination}</bdi> را وارد کنید.</>
    : intent === 'register' ? 'برای شروع مدیریت زیرساخت، حساب امن خود را بسازید.' : intent === 'forgot'
      ? method === 'phone' ? 'کد بازیابی را با پیامک به شمارهٔ همراه واردشده می‌فرستیم.' : 'کد بازیابی را به آدرس ایمیل واردشده می‌فرستیم.'
      : adminEntry ? 'با حساب مدیر پارس سرور وارد شوید.' : 'برای مدیریت سرویس‌های ابری وارد حساب خود شوید.'

  return (
    <main className={'auth-page' + (adminEntry ? ' auth-page--admin' : '')} dir="rtl">
      <div className="auth-layout">
        {!adminEntry && <AuthBrandPanel />}
        <section className="auth-card">
          <header className="auth-card-header">
            <Link className="public-logo" to="/"><BrandMark /><strong>{BRAND_NAME}</strong></Link>
            <span><ShieldCheck size={17} /> ورود امن</span>
          </header>

          {success ? (
            <div className="auth-success" role="status">
              <span><Check size={34} /></span>
              <h1>ورود موفقیت‌آمیز</h1>
              <p>در حال انتقال شما به پنل مدیریت…</p>
            </div>
          ) : (
            <>
              <div className="auth-heading">
                <h1>
                  <span className="auth-title-desktop">{title}</span>
                  <span className="auth-title-mobile">{!challenge && intent === 'login' ? 'خوش آمدید 👋' : title}</span>
                </h1>
                {!challenge && intent === 'login' ? <p>
                  <span className="auth-title-desktop">{subtitle}</span>
                  <span className="auth-title-mobile">برای ورود به پنل، اطلاعات حساب خود را وارد کنید.</span>
                </p> : <p>{subtitle}</p>}
              </div>
              {!challenge ? (
                <form className="auth-form" onSubmit={submitEntry} noValidate={method === 'phone'}>
                  {passwordReset && <p className="auth-security-hint" role="status">رمز عبور تغییر کرد. اکنون با رمز جدید وارد شوید.</p>}
                  <div className="auth-method-tabs" role="tablist" aria-label={intent === 'register' ? 'روش ثبت‌نام' : intent === 'forgot' ? 'روش بازیابی' : 'روش ورود'}>
                    {methods.map((tab, index) => <button key={tab} ref={node => { methodTabs.current[tab] = node }}
                      id={`auth-tab-${tab}`} aria-controls={`auth-panel-${tab}`} aria-selected={method === tab} tabIndex={method === tab ? 0 : -1}
                      className={method === tab ? 'active' : ''} disabled={busy} onClick={() => selectMethod(tab)} role="tab" type="button"
                      onKeyDown={event => {
                        const next = event.key === 'Home' ? methods[0] : event.key === 'End' ? methods.at(-1)
                          : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? methods[1 - index] : undefined
                        if (!next) return
                        event.preventDefault()
                        selectMethod(next)
                        methodTabs.current[next]?.focus()
                      }}>
                      {tab === 'phone' ? <><Phone size={17} /> {intent === 'register' ? 'ثبت‌نام با شماره همراه' : 'شماره همراه'}</>
                        : <><Mail size={17} /> {intent === 'register' ? 'ثبت‌نام با ایمیل' : intent === 'forgot' ? 'ایمیل بازیابی' : 'ایمیل و رمز عبور'}</>}
                    </button>)}
                  </div>
                  {methods.filter(tab => tab !== method).map(tab => <div key={tab} role="tabpanel" id={`auth-panel-${tab}`} aria-labelledby={`auth-tab-${tab}`} hidden />)}
                  <div key={method} className="auth-method-panel" role="tabpanel" id={`auth-panel-${method}`} aria-labelledby={`auth-tab-${method}`}>
                  {intent === 'register' && (
                    <div className="auth-name-row">
                      <label className="auth-field"><span>نام</span><input autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} value={firstName} /></label>
                      <label className="auth-field"><span>نام خانوادگی</span><input autoComplete="family-name" onChange={(e) => setLastName(e.target.value)} value={lastName} /></label>
                    </div>
                  )}
                  {method === 'phone' ? (
                    <label className="auth-field"><span id="login-mobile-label">شماره همراه</span><input autoComplete="tel" dir="ltr" inputMode="tel"
                      aria-labelledby="login-mobile-label" aria-invalid={!!mobileError} aria-describedby={mobileError ? 'login-mobile-error' : undefined}
                      onChange={e => { setMobile(e.target.value); setMobileError('') }} placeholder="09123456789" required value={mobile} />
                      {mobileError && <small className="auth-error" id="login-mobile-error" role="alert">{mobileError}</small>}
                    </label>
                  ) : (
                    <label className="auth-field"><span>آدرس ایمیل</span><input autoComplete="email" dir="ltr" onChange={(e) => setEmail(e.target.value)} placeholder="example@email.com" required type="email" value={email} /></label>
                  )}
                  {intent === 'login' && method === 'phone' && <button type="button" className="auth-text-link" disabled={busy} onClick={() => {
                    setPhonePassword(value => !value); setPassword(''); setShowPassword(false); setError(''); setPasswordError('')
                  }}>{phonePassword ? 'ورود با کد پیامکی' : 'ورود با رمز عبور'}</button>}
                  {intent !== 'forgot' && (method === 'email' || intent === 'login' && phonePassword) && (
                    <label className="auth-field"><span id="login-password-label">رمز عبور</span><span className="password-input">
                      <input autoComplete={intent === 'register' ? 'new-password' : 'current-password'} dir="ltr" minLength={intent === 'register' ? 8 : undefined}
                        aria-labelledby="login-password-label" aria-invalid={!!passwordError} aria-describedby={passwordError ? 'login-password-error' : undefined}
                        onChange={e => { setPassword(e.target.value); setPasswordError('') }} required type={showPassword ? 'text' : 'password'} value={password} />
                      <button aria-label={showPassword ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور'} onClick={() => setShowPassword(value => !value)} type="button">{showPassword ? <EyeOff /> : <Eye />}</button>
                    </span>{passwordError && <small id="login-password-error" className="auth-error" role="alert">{passwordError}</small>}</label>
                  )}
                  {intent === 'register' && method === 'email' && (
                    <label className="auth-field"><span>تکرار رمز عبور</span><input autoComplete="new-password" dir="ltr" minLength={8} onChange={(e) => setConfirmPassword(e.target.value)} required type={showPassword ? 'text' : 'password'} value={confirmPassword} /></label>
                  )}
                  {intent === 'login' && <Link className="auth-text-link" to={`/forgot-password?returnTo=${encodeURIComponent(returnTo)}${method === 'phone' ? '&method=phone' : ''}`} state={location.state}>رمز عبور را فراموش کرده‌اید؟</Link>}
                  {error && <p className="auth-error" role="alert">{error}</p>}
                  <button className="auth-primary-button" disabled={busy} type="submit">{busy ? <RefreshCw className="spin" size={19} /> : intent === 'register' ? 'ساخت حساب' : intent === 'forgot' ? 'ارسال کد بازیابی' : method === 'phone' && !phonePassword ? 'ارسال کد پیامکی' : 'ورود به حساب'}</button>
                  {(intent === 'register' || (intent === 'login' && method === 'email')) && <button className="auth-google-button" disabled={busy} onClick={googleLogin} type="button"><GoogleIcon /> {intent === 'register' ? 'ادامه با گوگل' : 'ورود با حساب گوگل'}</button>}
                  </div>
                  <p className="auth-switch-copy">{intent === 'register' ? <>حساب دارید؟ <Link to={`/login?returnTo=${encodeURIComponent(returnTo)}`} state={location.state}>وارد شوید</Link></> : intent === 'login' ? <>حساب ندارید؟ <Link to={`/register?returnTo=${encodeURIComponent(returnTo)}`} state={location.state}>ثبت‌نام کنید</Link></> : <Link to={`/login?returnTo=${encodeURIComponent(returnTo)}`} state={location.state}><ArrowLeft size={15} /> بازگشت به ورود</Link>}</p>
                </form>
              ) : (
                <form className="auth-form" onSubmit={submitChallenge} noValidate={intent === 'forgot'}>
                  {challenge.challengeType === 'totp' && !recoveryMode && <div className="auth-security-hint"><KeyRound size={18} /> Google Authenticator یا برنامه مشابه</div>}
                  {challenge.challengeType === 'totp' && recoveryMode ? (
                    <label className="auth-field"><span>کد بازیابی یک‌بارمصرف</span><input autoFocus dir="ltr" onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())} placeholder="ABCDE-12345" required value={recoveryCode} /></label>
                  ) : <OtpField inputRef={otpInput} disabled={busy || success || otpLocked} onChange={changeOtp} value={code} />}
                  {intent === 'forgot' && (
                    <>
                      <label className="auth-field"><span id="new-password-label">رمز عبور جدید</span><input autoComplete="new-password" dir="ltr" minLength={8} maxLength={200}
                        aria-labelledby="new-password-label" aria-invalid={!!passwordError} aria-describedby={passwordError ? 'new-password-error' : undefined}
                        onChange={e => { setPassword(e.target.value); setPasswordError(''); setConfirmationError('') }} required type="password" value={password} />
                        {passwordError && <small id="new-password-error" className="auth-error" role="alert">{passwordError}</small>}</label>
                      <label className="auth-field"><span id="repeat-password-label">تکرار رمز جدید</span><input autoComplete="new-password" dir="ltr" maxLength={200}
                        aria-labelledby="repeat-password-label" aria-invalid={!!confirmationError} aria-describedby={confirmationError ? 'repeat-password-error' : undefined}
                        onChange={e => { setConfirmPassword(e.target.value); setConfirmationError('') }} required type="password" value={confirmPassword} />
                        {confirmationError && <small id="repeat-password-error" className="auth-error" role="alert">{confirmationError}</small>}</label>
                    </>
                  )}
                  {intent === 'forgot' && <label className="auth-field"><span>کد برنامهٔ دومرحله‌ای (اگر فعال است)</span><input inputMode="numeric" dir="ltr" value={recoveryCode} onChange={e => setRecoveryCode(e.target.value)} autoComplete="off" /></label>}
                  {challenge.challengeType === 'email' && <EmailSpamHint />}
                  {challenge.developmentCode && <p className="auth-dev-code">حالت توسعه — کد: <b dir="ltr">{challenge.developmentCode}</b></p>}
                  {error && <p className="auth-error" role="alert">{error}</p>}
                  <div role="status">{resent && 'کد جدید ارسال شد.'}</div>
                  <button className="auth-primary-button" disabled={busy || success || otpLocked || challengeExpired || (!recoveryMode && code.length !== 6)} type="submit">{busy ? <RefreshCw className="spin" size={19} /> : intent === 'forgot' ? 'ثبت رمز عبور جدید' : intent === 'register' ? 'تأیید و تکمیل ثبت‌نام' : 'تأیید هویت و ورود'}</button>
                  {challenge.challengeType === 'totp' ? (
                    <button className="auth-secondary-button" disabled={busy} onClick={() => { setRecoveryMode((value) => !value); setError('') }} type="button"><LockKeyhole size={17} /> {recoveryMode ? 'استفاده از کد برنامه' : 'استفاده از کد بازیابی'}</button>
                  ) : (
                    challengeExpired ? <button className="auth-resend" disabled={busy} onClick={() => { smsReader.current?.abort(); setChallenge(null); setCode(''); setError(''); setOtpLocked(false); setReceivedSms(undefined) }} type="button">درخواست منقضی شده؛ شروع دوباره و دریافت کد جدید</button> : <button className="auth-resend" disabled={busy || success || otpLocked || countdown > 0} onClick={resend} type="button"><RefreshCw size={16} /> {countdown > 0 ? `ارسال مجدد تا ${countdown} ثانیه دیگر` : 'ارسال مجدد کد'}</button>
                  )}
                  <button className="auth-back" disabled={busy || success} onClick={() => { cancelSmsRead(); setChallenge(null); setCode(''); setError(''); setOtpLocked(false) }} type="button">اصلاح اطلاعات ورود</button>
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
      navigate(safeReturnPath(target), { replace: true })
    }).catch(() => setError('نشست ورود با گوگل قابل تأیید نیست.'))
  }, [navigate, params, refresh])
  return <main className="auth-page"><div className="route-loader"><span />{error ? <p>{error} <Link to="/login">بازگشت</Link></p> : <p>در حال تکمیل ورود با گوگل…</p>}</div></main>
}
