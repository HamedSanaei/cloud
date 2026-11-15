import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Server } from '../../lib/types'

/** Full API identifiers stay copyable even when the compact row truncates them. */
export function CopyableServerReference({ value, label = 'کپی شناسه' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (manual) { input.current?.focus(); input.current?.select() } }, [manual])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2200); return () => clearTimeout(timer) }, [copied])
  return <span className="server-reference">
    <bdi dir="ltr" title={value}>{value}</bdi>
    <button type="button" className="server-list-control" aria-label={`${label} ${value}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true) } catch { setManual(true) }
    }}>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<span>{label}</span></button>
    {copied && <span role="status">شناسه کپی شد</span>}
    {manual && <label className="server-reference__manual">شناسه را انتخاب و کپی کنید<input ref={input} readOnly dir="ltr" value={value} aria-label="شناسه برای کپی دستی" /></label>}
  </span>
}

/** Penpot FailureDetailsPanel Light/Dark: see docs/SERVER_LIST_DESIGN.md. */
export function FailureDetailsPanel({ server, failureState }: { server: Server; failureState: boolean }) {
  const failure = server.tracking?.failure
  const reference = failure?.reference || server.tracking?.reference
  return <section className="server-failure-panel" aria-label={failureState ? 'جزئیات خطای ساخت سرور' : 'جزئیات وضعیت ساخت سرور'}>
    <header className={failureState ? 'server-failure-panel__heading' : 'server-failure-panel__heading server-failure-panel__heading--pending'}>
      <h3>{failureState ? 'علت خطای ساخت سرور' : 'وضعیت ساخت سرور'}</h3>
      <span>درخواست مربوط به <bdi>{server.name}</bdi></span>
    </header>
    <div className="server-failure-panel__reason"><strong>{failureState ? 'شرح خطا' : 'وضعیت درخواست'}</strong>
      <p>{failure?.message || (failureState ? 'جزئیات تأییدشدهٔ خطا هنوز در دسترس نیست؛ از پشتیبانی پیگیری کنید.' : 'درخواست در حال پیگیری است؛ اطلاعات سرور پس از تأیید نمایش داده می‌شود.')}</p>
    </div>
    {(failure || failureState) && <p className="server-failure-panel__billing">{failure?.billing === 'refunded' ? 'مبلغ پرداخت‌شده به کیف پول بازگردانده شد.'
      : failure?.billing === 'not_charged' ? 'مبلغی بابت این سفارش از کیف پول کسر نشده است.'
        : failure?.billing === 'captured' ? 'مبلغ کسرشده هنوز بازگردانده نشده و نیازمند پیگیری است.'
          : 'وضعیت مالی این سفارش هنوز تأیید نشده است؛ از پشتیبانی پیگیری کنید.'}</p>}
    {reference && <div className="server-failure-panel__reference"><strong>شمارهٔ پیگیری</strong><CopyableServerReference key={reference} value={reference} /></div>}
    {failure?.nextStep && <p className="server-failure-panel__guidance">{failure.nextStep}</p>}
    <div className="server-failure-panel__actions">
      <Link className="server-list-control server-list-control--primary" to="/tickets">پیگیری از پشتیبانی</Link>
      {failure?.canChooseAlternative && <Link className="server-list-control" to="/servers/create">انتخاب پلن یا دیتاسنتر دیگر</Link>}
    </div>
  </section>
}
