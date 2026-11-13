import { Bell, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getNotifications, markNotificationsRead } from '../../lib/endpoints'
import { formatFaDateTime } from '../../lib/format'
import { claimNotificationToasts } from '../../lib/notificationDelivery'
import { useToast } from '../ui/Toast'

export function NotificationCenter({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const { data, loading, error, refetch } = useApiQuery(getNotifications)
  const { showToast } = useToast()

  useEffect(() => {
    if (loading) return
    const refresh = () => { if (document.visibilityState === 'visible') refetch() }
    const timer = window.setTimeout(refresh, 10_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('notifications-changed', refresh)
    window.addEventListener('integration-changed', refresh)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('notifications-changed', refresh)
      window.removeEventListener('integration-changed', refresh)
    }
  }, [loading, refetch])

  useEffect(() => {
    if (!data?.length) return
    let active = true
    void claimNotificationToasts(userId, data, () => active).then(fresh => {
      if (!active) return
      if (fresh.length > 3) { setOpen(true); return }
      for (const item of [...fresh].reverse()) {
        const type = item.type === 'success' || item.type === 'error' || item.type === 'warning' ? item.type : 'info'
        showToast(item.body ? `${item.title} — ${item.body}` : item.title, type, `notification:${userId}:${item.id}`)
      }
    })
    return () => { active = false }
  }, [data, showToast, userId])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); bell.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const unread = (data ?? []).filter(item => !item.read)
  const read = async (ids: string[]) => {
    setSaving(true)
    setSaveError('')
    try { await markNotificationsRead(ids); refetch() }
    catch { setSaveError('ثبت وضعیت خواندن ناموفق بود. دوباره تلاش کنید.') }
    finally { setSaving(false) }
  }

  return <div className="menu-anchor" ref={anchor}>
    <button ref={bell} type="button" className="icon-button" onClick={() => setOpen(value => !value)}
      aria-label="اعلان‌ها" aria-expanded={open} aria-controls="notification-center">
      <Bell size={20} />
      {unread.length > 0 && <span className="notification-dot" aria-label="اعلان خوانده‌نشده" />}
    </button>
    {open && <section className="popover popover--notifications" id="notification-center" aria-label="مرکز اعلان‌ها" dir="rtl">
      <header className="notification-center__heading">
        <strong>اعلان‌ها</strong>
        <button type="button" className="icon-button" onClick={() => { setOpen(false); bell.current?.focus() }} aria-label="بستن اعلان‌ها"><X size={18} /></button>
      </header>
      {error && <p role="alert">دریافت اعلان‌ها ناموفق بود. <button type="button" onClick={refetch}>تلاش دوباره</button></p>}
      {saveError && <p role="alert">{saveError}</p>}
      {loading && !data && <p>در حال دریافت…</p>}
      {data?.length === 0 && <p>اعلانی ندارید.</p>}
      {unread.length > 0 && <button type="button" className="notification-center__read" disabled={saving}
        onClick={() => void read(unread.map(item => item.id))}>خواندن همه</button>}
      {data?.map(item => <article className="notification-item" key={item.id}>
        <strong>{item.title}</strong>
        {item.body && <p>{item.body}</p>}
        <footer>
          {item.createdAt && <time dateTime={item.createdAt}>{formatFaDateTime(item.createdAt)}</time>}
          {item.read ? <span>خوانده‌شده</span> : <button type="button" disabled={saving}
            aria-label={`خواندم ${item.title}`} onClick={() => void read([item.id])}>خوانده‌نشده · خواندم</button>}
          {item.href && <Link to={item.href} onClick={() => setOpen(false)}>مشاهده جزئیات</Link>}
        </footer>
      </article>)}
    </section>}
  </div>
}
