import { useEffect, useState } from 'react'
import { renderHomeTariffs, type IranTariffs, type PublicHetznerOffer } from '../../backend/src/contracts/home-tariffs'

// Used by the build preview and whenever the public endpoint is unreachable.
export const fallbackTariffs = renderHomeTariffs(null, null)

export function HomeTariffs({ initialHtml }: { initialHtml?: string }) {
  const [html, setHtml] = useState(initialHtml ?? fallbackTariffs)
  const [loading, setLoading] = useState(!initialHtml)
  useEffect(() => {
    let active = new AbortController()
    const refresh = async () => {
      active.abort()
      const controller = new AbortController()
      active = controller
      try {
        const response = await fetch('/api/public/home-prices', {
          credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        })
        if (!response.ok) throw new Error('Tariffs unavailable')
        const { data } = await response.json() as { data: { iran: IranTariffs | null; hetzner: PublicHetznerOffer[] | null } }
        if (!controller.signal.aborted) setHtml(renderHomeTariffs(data.iran, data.hetzner))
      } catch {
        if (!controller.signal.aborted) setHtml(fallbackTariffs)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    if (!initialHtml) void refresh()
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 60_000)
    const resume = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', refresh)
    return () => { active.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh) }
  }, [initialHtml])

  return <section id="tariffs" className="landing-section public-container landing-tariffs" aria-labelledby="tariffs-title">
    <h2 id="tariffs-title">تعرفه‌ها</h2>
    {loading && <p role="status">در حال دریافت تعرفه‌ها…</p>}
    <div id="home-tariff-content" dangerouslySetInnerHTML={{ __html: html }} />
  </section>
}
