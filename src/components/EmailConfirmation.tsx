import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../lib/apiClient'
import { toAsciiDigits } from '../lib/format'
import { cancelOperationEmail, startOperationEmail, type EmailChallenge, type EmailProof, type OperationIntent } from '../lib/operationEmail'
import { Button } from './ui/Button'
import { Input } from './ui/FormControls'
import { Modal } from './ui/Modal'
import { EmailSpamHint } from './EmailSpamHint'

export type ActiveEmailChallenge = EmailChallenge & { expires: number; resendAt: number }
export function EmailCode({ start, submit, cancel, onToken, initialChallenge, onChallenge, children }: {
  start: (token?: string) => Promise<EmailChallenge>; submit: (proof: EmailProof) => Promise<void>
  cancel: () => void; onToken?: (token: string) => void; initialChallenge?: ActiveEmailChallenge
  onChallenge?: (challenge: ActiveEmailChallenge) => void; children?: ReactNode
}) {
  const [challenge, setChallenge] = useState<ActiveEmailChallenge | null>(initialChallenge ?? null)
  const [now, setNow] = useState(Date.now), [code, setCode] = useState(''), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [needsEmail, setNeedsEmail] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!challenge) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [challenge])
  async function perform(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError(''); setNeedsEmail(false)
    try { await action() }
    catch (err) {
      setError(err instanceof Error ? err.message : 'تأیید ایمیل ناموفق بود')
      setNeedsEmail(err instanceof ApiError && (err.body as { error?: string })?.error === 'verified_email_required')
    } finally { setBusy(false) }
  }
  const send = () => perform(async () => {
    const next = await start(challenge && now < challenge.expires ? challenge.token : undefined), timestamp = Date.now()
    const { token, expiresIn, resendAfter, destination } = next
    const issued = { token, expiresIn, resendAfter, destination, expires: timestamp + expiresIn * 1000, resendAt: timestamp + resendAfter * 1000 }
    onToken?.(next.token)
    if (!mounted.current) return
    setNow(timestamp); setCode('')
    setChallenge(issued)
    onChallenge?.(issued)
  })
  return <div className="form-stack">
    {(!challenge || now >= challenge.expires) && children}
    {challenge && <>
      <p>کد به <bdi>{challenge.destination}</bdi> فرستاده شد. {now < challenge.expires ? `${Math.ceil((challenge.expires - now) / 1000).toLocaleString('fa-IR')} ثانیه تا پایان اعتبار` : 'اعتبار کد تمام شده است.'}</p>
      <EmailSpamHint />
      <Input label="کد تأیید ایمیل" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={code}
        onChange={event => setCode(toAsciiDigits(event.target.value).replace(/\D/g, ''))} />
    </>}
    {error && <p role="alert">{error}</p>}
    {needsEmail && <Link to="/profile/update" onClick={cancel}>تأیید ایمیل در پروفایل</Link>}
    <div className="server-inline-actions">
      {challenge && <Button type="button" disabled={busy || code.length !== 6 || now >= challenge.expires}
        onClick={() => void perform(() => submit({ token: challenge.token, code }))}>تأیید کد و ادامه</Button>}
      <Button type="button" variant={challenge ? 'secondary' : 'primary'} disabled={busy || !!challenge && now < challenge.resendAt}
        onClick={() => void send()}>{challenge ? 'ارسال دوبارهٔ کد' : 'ارسال کد به ایمیل'}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>انصراف</Button>
    </div>
  </div>
}

export function OperationEmail({ intent, children, execute, close }: {
  intent: OperationIntent; children?: ReactNode; execute: (proof: EmailProof) => Promise<void>; close: () => void
}) {
  const token = useRef<string>(undefined)
  const closed = useRef(false)
  const cancel = () => {
    closed.current = true
    if (token.current) void cancelOperationEmail(token.current).catch(() => undefined)
    close()
  }
  const saveToken = (next: string) => {
    if (closed.current) void cancelOperationEmail(next).catch(() => undefined)
    else token.current = next
  }
  return <Modal open trapFocus title="تأیید ایمیلی عملیات سرور" onClose={cancel}>
    {children}
    <EmailCode start={() => startOperationEmail(intent)} submit={execute} cancel={cancel} onToken={saveToken} />
  </Modal>
}
