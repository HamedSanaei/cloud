import { useEffect, useRef, useState } from 'react'
import { apiPost } from '../lib/apiClient'
import { type AuthChallenge, resendChallenge } from '../lib/auth'
import { Button } from './ui/Button'
import { Input } from './ui/FormControls'
import { Card, SectionHeading } from './ui/Card'

export function AccountPasswordSettings() {
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null)
  const [currentPassword, setCurrentPassword] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('')
  const [code, setCode] = useState(''), [totp, setTotp] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [remaining, setRemaining] = useState(0), [resendWait, setResendWait] = useState(0)
  const inFlight = useRef(false)
  useEffect(() => {
    setRemaining(challenge?.expiresIn ?? 0); setResendWait(challenge?.resendAfter ?? 0)
    if (!challenge) return
    const until = Date.now() + challenge.expiresIn * 1000, resendAt = Date.now() + challenge.resendAfter * 1000
    const timer = window.setInterval(() => { setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000))); setResendWait(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000))) }, 1000)
    return () => clearInterval(timer)
  }, [challenge])
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setMessage('')
    try { await action() } catch (e) { setMessage(e instanceof Error ? e.message : 'عملیات ناموفق بود') }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function start() { setChallenge((await apiPost<{ data: AuthChallenge }>('/auth/account/operation/start', {}, { timeoutMs: 30000 })).data); setCode('') }
  async function save() {
    if (password !== confirm) { setMessage('رمز جدید و تکرار آن یکسان نیستند'); return }
    await apiPost('/auth/account/password', { token: challenge!.challengeToken, code, password, currentPassword, ...(totp ? { totp } : {}) })
    setChallenge(null); setPassword(''); setConfirm(''); setCurrentPassword(''); setCode(''); setTotp(''); setMessage('رمز عبور تغییر کرد.')
  }
  return <Card><SectionHeading title="تغییر امن رمز عبور" /><div className="form-stack">
    <p>کد عملیات به شمارهٔ تأییدشدهٔ حساب ارسال می‌شود. این کد فقط برای تغییر رمز در همین نشست معتبر است.</p>
    {!challenge || remaining === 0 ? <Button disabled={busy} onClick={() => run(start)}>{challenge ? 'درخواست منقضی شد؛ دریافت کد جدید' : 'دریافت کد تأیید عملیات'}</Button> : <form className="form-stack" onSubmit={e => { e.preventDefault(); void run(save) }}>
      <p>کد به <bdi>{challenge.destination}</bdi> ارسال شد؛ اعتبار {remaining} ثانیه.</p>
      <Input label="کد پیامکی" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required maxLength={6} />
      <Input label="رمز فعلی" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} type="password" autoComplete="current-password" required />
      <Input label="رمز جدید" value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete="new-password" required minLength={8} />
      <Input label="تکرار رمز جدید" value={confirm} onChange={e => setConfirm(e.target.value)} type="password" autoComplete="new-password" required />
      <Input label="کد برنامهٔ دومرحله‌ای (اگر فعال است)" value={totp} onChange={e => setTotp(e.target.value)} inputMode="numeric" />
      <Button disabled={busy} type="submit">تأیید و تغییر رمز</Button><Button variant="secondary" disabled={busy || resendWait > 0} onClick={() => run(async () => { setChallenge(await resendChallenge(challenge.challengeToken)); setCode('') })}>{resendWait ? `ارسال مجدد پس از ${resendWait} ثانیه` : 'ارسال مجدد'}</Button>
    </form>}
    {message ? <p role="status">{message}</p> : null}
  </div></Card>
}
