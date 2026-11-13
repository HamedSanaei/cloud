import { useEffect, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { getApiBaseUrl } from '../../lib/apiClient'
import { requestServerConsole } from '../../lib/serverManagement'

export function ServerConsole({ serverId, disabled }: { serverId: string; disabled: boolean }) {
  const target = useRef<HTMLDivElement>(null), client = useRef<RFB | null>(null), mounted = useRef(true), connecting = useRef(false), timer = useRef<number | undefined>(undefined)
  const [status, setStatus] = useState('برای دسترسی امن، یک نشست موقت ایجاد کنید.'), [busy, setBusy] = useState(false)
  const generation = useRef({ value: 0 })
  useEffect(() => {
    mounted.current = true
    const scope = generation.current
    const hide = () => { if (document.visibilityState === 'hidden') { scope.value++; client.current?.disconnect(); client.current = null } }
    document.addEventListener('visibilitychange', hide)
    return () => { mounted.current = false; scope.value++; window.clearTimeout(timer.current); client.current?.disconnect(); client.current = null; document.removeEventListener('visibilitychange', hide) }
  }, [serverId])
  const connect = async () => {
    if (connecting.current || disabled) return
    connecting.current = true; setBusy(true)
    const version = ++generation.current.value
    client.current?.disconnect(); window.clearTimeout(timer.current)
    try {
      const grant = await requestServerConsole(serverId)
      const { default: Viewer } = await import('@novnc/novnc')
      if (!mounted.current || !target.current || version !== generation.current.value || document.visibilityState === 'hidden') return
      const url = new URL(`${getApiBaseUrl()}/servers/${encodeURIComponent(serverId)}/console/${encodeURIComponent(grant.grantId)}`, location.origin)
      if (url.origin !== location.origin) throw new Error('Console requires same-origin session')
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const rfb = new Viewer(target.current, url.toString(), { credentials: { password: grant.password } })
      rfb.scaleViewport = true; rfb.resizeSession = false; client.current = rfb
      setStatus('در حال اتصال به کنسول موقت…')
      rfb.addEventListener('connect', () => { if (mounted.current) setStatus('کنسول متصل است؛ نشست حداکثر پنج دقیقه اعتبار دارد.') })
      rfb.addEventListener('disconnect', () => { if (mounted.current) setStatus('ارتباط کنسول پایان یافت. برای اتصال مجدد، نشست جدید بسازید.') })
      rfb.addEventListener('securityfailure', () => { if (mounted.current) setStatus('احراز هویت کنسول موفق نبود؛ اتصال جدید نیازمند نشست جدید است.') })
      timer.current = window.setTimeout(() => { rfb.disconnect(); client.current = null }, Math.min(300, grant.maxSessionSeconds) * 1000)
    } catch { if (mounted.current) setStatus('کنسول در دسترس نیست. نشست مرورگر، مجوز پروژه و اتصال امن WebSocket را بررسی کنید.') }
    finally { connecting.current = false; if (mounted.current) setBusy(false) }
  }
  return <Card className="server-console"><h2>کنسول مرورگر</h2><p role="status">{status}</p><div className="server-console-viewer" ref={target} aria-label="نمایشگر امن کنسول سرور" />
    <div className="server-inline-actions"><Button disabled={disabled || busy} onClick={connect}>ایجاد نشست موقت</Button><Button variant="secondary" onClick={() => { generation.current.value++; client.current?.disconnect(); client.current = null }}>پایان نشست</Button></div><small>نشست فقط برای همین حساب و سرور است و با خروج از تب قطع می‌شود.</small>
  </Card>
}
