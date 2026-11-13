import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/ui/Toast'
import { getServerTracking, listServers } from '../lib/endpoints'
import { acceptedServers, claimLifecycleNotice, forgetAcceptedServer, isProvisioning, serverRowKey } from '../lib/serverLifecycle'
import type { Server } from '../lib/types'

export function useServerFleet(enabled = true) {
  const { user } = useAuth(), { showToast } = useToast()
  const [data, setData] = useState<Server[]>([]), [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null), [paused, setPaused] = useState(false)
  const generation = useRef(0), rounds = useRef(0)
  const latest = useRef<{ userId: string; rows: Server[] }>({ userId: user?.id ?? '', rows: [] })
  const [refresh, setRefresh] = useState(0)
  const refetch = useCallback(() => { rounds.current = 0; setPaused(false); setRefresh(n => n + 1) }, [])
  useEffect(() => {
    if (!enabled) return
    const version = ++generation.current
    let stopped = false, timer: number | undefined
    const controller = new AbortController()
    let rows = latest.current.userId === (user?.id ?? '') ? latest.current.rows : []
    const valid = () => !stopped && generation.current === version
    async function publish(next: Server[]) {
      if (!valid()) return
      const changed = next.some(row => rows.some(prior => serverRowKey(prior) === serverRowKey(row) && isProvisioning(prior) && !isProvisioning(row)))
      rows = next; latest.current = { userId: user?.id ?? '', rows }; setData(rows)
      if (changed) window.dispatchEvent(new Event('server-lifecycle-changed'))
      for (const row of rows) {
        if (!valid()) return
        if (!isProvisioning(row)) forgetAcceptedServer(user?.id ?? '', row)
        if (row.tracking?.source !== 'platform') continue
        const notify = await claimLifecycleNotice(user?.id ?? '', row, valid)
        if (notify && valid()) {
          const ready = row.tracking?.state === 'ready'
          showToast(ready ? `سرور «${row.name}» با موفقیت ساخته شد و آماده استفاده است.` : `ساخت سرور «${row.name}» تکمیل نشد؛ برای پیگیری با پشتیبانی تماس بگیرید.`, ready ? 'success' : 'error', `${user?.id}:${serverRowKey(row)}:terminal`)
        }
      }
    }
    const schedule = () => {
      if (!valid() || !rows.some(row => isProvisioning(row) || row.power.pendingAction)) return
      if (rounds.current >= 60) { setPaused(true); return }
      timer = window.setTimeout(poll, Math.min(3000 * 1.3 ** rounds.current, 30000))
    }
    const poll = async () => {
      if (!valid()) return
      if (document.visibilityState === 'hidden') { schedule(); return }
      rounds.current++
      const pending = rows.filter(isProvisioning)
      const hasPendingPower = rows.some(row => row.power.pendingAction)
      const [results, fleet] = await Promise.all([
        Promise.allSettled(pending.map(row => getServerTracking(row.tracking!, controller.signal))),
        hasPendingPower ? listServers().catch(() => null) : null,
      ])
      if (!valid()) return
      setError((hasPendingPower && !fleet) || results.some(result => result.status === 'rejected') ? 'ارتباط موقتاً قطع است؛ آخرین وضعیت حفظ شده و دوباره بررسی می‌شود.' : null)
      const replacements = new Map(results.flatMap((result, i) => result.status === 'fulfilled' ? [[serverRowKey(pending[i]), result.value] as const] : []))
      for (const row of fleet ?? []) if (!replacements.has(serverRowKey(row))) replacements.set(serverRowKey(row), row)
      await publish(rows.map(row => replacements.get(serverRowKey(row)) ?? row))
      if (valid()) schedule()
    }
    const start = async () => {
      const immediate = acceptedServers(user?.id ?? '')
      if (immediate.length) { await publish([...immediate, ...rows.filter(row => !immediate.some(item => serverRowKey(item) === serverRowKey(row)))]); setLoading(false) }
      try {
        const result = await listServers()
        if (!valid()) return
        const merged = [...rows.map(row => result.find(item => serverRowKey(item) === serverRowKey(row)) ?? row), ...result.filter(item => !rows.some(row => serverRowKey(item) === serverRowKey(row)))]
        await publish(merged); setError(null)
      } catch { if (valid()) setError('دریافت وضعیت سرورها ناموفق بود؛ درخواست جدیدی ثبت نکنید.') }
      finally { if (valid()) { setLoading(false); schedule() } }
    }
    const onFocus = () => { if (document.visibilityState === 'visible') refetch() }
    window.addEventListener('focus', onFocus)
    void start()
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); window.removeEventListener('focus', onFocus) }
  }, [enabled, refresh, user?.id, showToast, refetch])
  return { data, loading, error, paused, refetch }
}
