import { useEffect, useId, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { Card } from '../ui/Card'
import { Button, LinkButton } from '../ui/Button'
import { ApiError, getApiBaseUrl } from '../../lib/apiClient'
import { requestServerConsole, revokeServerConsole, type ServerDetail } from '../../lib/serverManagement'
import { consoleSessionExpiredCode } from '../../../backend/src/contracts/server-console'

type Block = NonNullable<ServerDetail['consoleBlock']> | 'checking' | 'refresh_failed' | 'cross_origin'
type Phase = 'idle' | 'requesting' | 'connecting' | 'connected'
interface Attempt { grantId?: string; viewer?: RFB; socket?: WebSocket; timeout?: number }
const expiredNotice = 'مهلت نشست موقت کنسول به پایان رسید. برای اتصال دوباره نشست جدید بسازید.'

const blockedMessages: Record<Block, string> = {
  operation_pending: 'نتیجهٔ عملیات قبلی سرور هنوز مشخص نشده است. ابتدا وضعیت آن را بررسی کنید.',
  deletion_pending: 'حذف سرور در حال پیگیری است. نتیجه را در بخش عملیات بررسی کنید.',
  server_deleted: 'این سرور حذف شده است.',
  server_not_ready: 'سرور هنوز آمادهٔ مدیریت نیست. پس از آماده‌شدن، وضعیت را دوباره بررسی کنید.',
  provider_unavailable: 'دریافت وضعیت سرور از ارائه‌دهنده فعلاً ممکن نیست.',
  provider_access_denied: 'دسترسی به سرور در پروژهٔ ارائه‌دهنده تأیید نشد. با پشتیبانی تماس بگیرید.',
  unsupported: 'کنسول مرورگر برای این سرور پشتیبانی نمی‌شود.',
  browser_session_required: 'برای ساخت نشست کنسول، دوباره در همین مرورگر وارد حساب خود شوید.',
  rebuild_protected: 'حفاظت سرور فعال است. وضعیت سرور را بررسی کنید.',
  checking: 'در حال بررسی امکان ساخت نشست…',
  refresh_failed: 'دریافت آخرین وضعیت سرور ناموفق بود. دوباره بررسی کنید.',
  cross_origin: 'کنسول به اتصال امن از همین نشانی پنل نیاز دارد. با پشتیبانی تماس بگیرید.',
}

function discardGrant(serverId: string, grantId: string) {
  void revokeServerConsole(serverId, grantId).catch(() => { /* Unused grants also expire on the server. */ })
}

function dispose(serverId: string, attempt: Attempt) {
  window.clearTimeout(attempt.timeout)
  attempt.viewer?.disconnect()
  if (attempt.socket && attempt.socket.readyState < WebSocket.CLOSING) attempt.socket.close()
  if (attempt.grantId) discardGrant(serverId, attempt.grantId)
}

export function ServerConsole({ serverId, block, recheck, openOperations }: {
  serverId: string; block: Block | null; recheck: () => void; openOperations: () => void
}) {
  const target = useRef<HTMLDivElement>(null)
  const current = useRef<Attempt | null>(null)
  const entry = useRef<HTMLButtonElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState('')
  const statusId = useId(), blockId = useId(), viewerId = useId(), keyboardId = useId()
  const consoleUrl = new URL(`${getApiBaseUrl()}/servers/${encodeURIComponent(serverId)}/console/`, location.origin)
  const reason = consoleUrl.origin !== location.origin ? 'cross_origin' : block

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'hidden' || !current.current) return
      const attempt = current.current
      current.current = null
      dispose(serverId, attempt)
      setPhase('idle')
      setExpanded(false)
      setNotice('با خروج از تب، نشست کنسول پایان یافت. برای اتصال دوباره نشست جدید بسازید.')
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      const attempt = current.current
      current.current = null
      if (attempt) dispose(serverId, attempt)
    }
  }, [serverId])

  const end = (attempt: Attempt, message: string) => {
    if (current.current !== attempt) return
    current.current = null
    dispose(serverId, attempt)
    setPhase('idle')
    setExpanded(false)
    setNotice(message)
  }

  const connect = async () => {
    if (current.current || reason) return
    const attempt: Attempt = {}
    current.current = attempt
    setPhase('requesting')
    setNotice('')
    try {
      const { default: Viewer } = await import('@novnc/novnc')
      if (current.current !== attempt) return
      const grant = await requestServerConsole(serverId)
      if (current.current !== attempt) { discardGrant(serverId, grant.grantId); return }
      attempt.grantId = grant.grantId
      setPhase('connecting')
      if (!target.current || document.visibilityState === 'hidden') {
        end(attempt, 'نشست موقت پایان یافت. برای اتصال دوباره نشست جدید بسازید.')
        return
      }
      const url = new URL(encodeURIComponent(grant.grantId), consoleUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      // noVNC accepts a public WebSocket channel; retain its explicit close reason.
      const socket = new WebSocket(url.toString())
      attempt.socket = socket
      socket.addEventListener('close', event => {
        if (event.code === consoleSessionExpiredCode) end(attempt, expiredNotice)
      }, { once: true })
      const viewer = new Viewer(target.current, socket, { credentials: { password: grant.password } })
      let connected = false
      attempt.viewer = viewer
      viewer.scaleViewport = true
      viewer.resizeSession = false
      const expiresIn = Date.parse(grant.expiresAt) - Date.now()
      attempt.timeout = window.setTimeout(() => end(attempt, 'مهلت اتصال به نشست موقت تمام شد. نشست جدید بسازید.'), Math.max(0, expiresIn))
      viewer.addEventListener('connect', () => {
        if (current.current !== attempt) return
        connected = true
        attempt.grantId = undefined
        window.clearTimeout(attempt.timeout)
        attempt.timeout = window.setTimeout(() => end(attempt, expiredNotice), Math.min(300, grant.maxSessionSeconds) * 1000)
        setPhase('connected')
      })
      viewer.addEventListener('disconnect', () => {
        attempt.viewer = undefined
        end(attempt, connected ? 'ارتباط قطع شد و نشست پایان یافت. برای اتصال دوباره نشست جدید بسازید.'
          : 'ارتباط با کنسول سرور برقرار نشد. دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.')
      })
      viewer.addEventListener('securityfailure', () => end(attempt, 'احراز هویت کنسول ناموفق بود. برای تلاش دوباره نشست جدید بسازید.'))
    } catch (error) {
      const message = error instanceof ApiError && error.status === 401 ? blockedMessages.browser_session_required
        : error instanceof ApiError && error.status === 403 ? 'ساخت نشست مجاز نیست. وضعیت ورود و دسترسی سرور را بررسی کنید.'
          : error instanceof ApiError && error.status === 409 ? `${error.message} برای مشاهدهٔ وضعیت تازه، «بروزرسانی» را بزنید.`
            : error instanceof ApiError && error.status === 429 ? 'تعداد درخواست‌های نشست زیاد است. کمی بعد دوباره تلاش کنید.'
            : 'ساخت یا اتصال نشست کنسول ناموفق بود. دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.'
      end(attempt, message)
    }
  }

  const status = phase === 'requesting' ? 'در حال ساخت نشست موقت…'
    : phase === 'connecting' ? 'نشست موقت ایجاد شده و هنوز متصل نیست. می‌توانید منتظر اتصال بمانید یا نشست را پایان دهید.'
      : phase === 'connected' ? 'کنسول متصل است. نشست حداکثر پنج دقیقه اعتبار دارد.'
        : notice || 'کنسول هنوز متصل نیست و نشست موقتی باز نیست.'
  const canEnd = phase === 'connecting' || phase === 'connected'
  const canRefresh = reason && ['provider_unavailable', 'server_not_ready', 'refresh_failed', 'browser_session_required'].includes(reason)

  return <Card className={`server-console${expanded ? ' server-console--expanded' : ''}`}>
    <h2>کنسول مرورگر</h2>
    <p id={statusId} role="status">{status}</p>
    {phase === 'connected' && <div className="server-console-tools">
      <button ref={entry} type="button" className="button button--secondary button--sm" aria-controls={viewerId} aria-describedby={keyboardId} onClick={() => current.current?.viewer?.focus()}>ورود با صفحه‌کلید به کنسول</button>
      <Button size="sm" variant="secondary" aria-expanded={expanded} aria-controls={viewerId} onClick={() => setExpanded(value => !value)}>{expanded ? 'اندازهٔ معمول کنسول' : 'بزرگ‌کردن کنسول'}</Button>
    </div>}
    <div id={viewerId} className="server-console-viewer" ref={target} aria-label="نمایشگر امن کنسول سرور" onKeyDownCapture={event => {
      if (event.key === 'Escape' && event.ctrlKey && event.altKey) {
        event.preventDefault(); event.stopPropagation()
        // Release modifiers already sent to the guest before moving focus out.
        for (const [symbol, code] of [[0xffe3, 'ControlLeft'], [0xffe4, 'ControlRight'], [0xffe9, 'AltLeft'], [0xffea, 'AltRight']] as const) current.current?.viewer?.sendKey(symbol, code, false)
        current.current?.viewer?.blur(); entry.current?.focus()
      }
    }} />
    {phase === 'connected' && <p id={keyboardId} className="server-console-keyboard-help">کلید Tab داخل کنسول به سرور ارسال می‌شود. برای بازگشت به کنترل‌های صفحه، <kbd dir="ltr">Ctrl + Alt + Escape</kbd> را بزنید.</p>}
    {reason && <div className="server-notice server-access-notice">
      <p id={blockId}>{blockedMessages[reason]}</p>
      <div className="server-inline-actions">
        {(reason === 'operation_pending' || reason === 'deletion_pending') && <Button size="sm" variant="secondary" onClick={openOperations}>مشاهدهٔ عملیات</Button>}
        {canRefresh && <Button size="sm" variant="secondary" onClick={recheck}>بررسی دوبارهٔ وضعیت</Button>}
        {(reason === 'provider_access_denied' || reason === 'cross_origin') && <LinkButton size="sm" variant="secondary" to="/tickets">پشتیبانی</LinkButton>}
      </div>
    </div>}
    <div className="server-inline-actions server-console-actions">
      <Button disabled={phase !== 'idle' || !!reason} aria-describedby={reason ? blockId : statusId} onClick={() => void connect()}>ایجاد نشست موقت</Button>
      <Button variant="secondary" disabled={!canEnd} aria-describedby={statusId} onClick={() => {
        if (current.current) end(current.current, 'نشست کنسول پایان یافت. برای اتصال دوباره نشست جدید بسازید.')
      }}>پایان نشست</Button>
    </div>
    <small>نشست فقط برای همین حساب و سرور است و با خروج از این بخش یا تب پایان می‌یابد.</small>
  </Card>
}
