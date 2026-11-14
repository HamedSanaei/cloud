import { useEffect, useId, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { Card } from '../ui/Card'
import { Button, LinkButton } from '../ui/Button'
import { ApiError, getApiBaseUrl } from '../../lib/apiClient'
import { requestServerConsole, revokeServerConsole, type ServerDetail } from '../../lib/serverManagement'

type Block = NonNullable<ServerDetail['consoleBlock']> | 'checking' | 'refresh_failed' | 'cross_origin'
type Phase = 'idle' | 'requesting' | 'connecting' | 'connected'
interface Attempt { grantId?: string; viewer?: RFB; timeout?: number }

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
  if (attempt.grantId) discardGrant(serverId, attempt.grantId)
}

export function ServerConsole({ serverId, block, recheck, openOperations }: {
  serverId: string; block: Block | null; recheck: () => void; openOperations: () => void
}) {
  const target = useRef<HTMLDivElement>(null)
  const current = useRef<Attempt | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [notice, setNotice] = useState('')
  const statusId = useId(), blockId = useId()
  const consoleUrl = new URL(`${getApiBaseUrl()}/servers/${encodeURIComponent(serverId)}/console/`, location.origin)
  const reason = consoleUrl.origin !== location.origin ? 'cross_origin' : block

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'hidden' || !current.current) return
      const attempt = current.current
      current.current = null
      dispose(serverId, attempt)
      setPhase('idle')
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
      const viewer = new Viewer(target.current, url.toString(), { credentials: { password: grant.password } })
      attempt.viewer = viewer
      viewer.scaleViewport = true
      viewer.resizeSession = false
      const expiresIn = Date.parse(grant.expiresAt) - Date.now()
      attempt.timeout = window.setTimeout(() => end(attempt, 'مهلت اتصال به نشست موقت تمام شد. نشست جدید بسازید.'), Math.max(0, expiresIn))
      viewer.addEventListener('connect', () => {
        if (current.current !== attempt) return
        attempt.grantId = undefined
        window.clearTimeout(attempt.timeout)
        attempt.timeout = window.setTimeout(() => end(attempt, 'مهلت نشست کنسول تمام شد. برای اتصال دوباره نشست جدید بسازید.'), Math.min(300, grant.maxSessionSeconds) * 1000)
        setPhase('connected')
      })
      viewer.addEventListener('disconnect', () => {
        attempt.viewer = undefined
        end(attempt, 'ارتباط قطع شد و نشست پایان یافت. برای اتصال دوباره نشست جدید بسازید.')
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

  return <Card className="server-console">
    <h2>کنسول مرورگر</h2>
    <p id={statusId} role="status">{status}</p>
    <div className="server-console-viewer" ref={target} aria-label="نمایشگر امن کنسول سرور" />
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
