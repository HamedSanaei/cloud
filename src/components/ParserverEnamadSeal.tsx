import { useEffect, useRef, useState } from 'react'

const verificationUrl = 'https://trustseal.enamad.ir/?id=8381321&Code=vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'

// The eNamad-issued snippet must remain byte-for-byte unchanged.
export const PARSERVER_ENAMAD_HTML = `<a referrerpolicy='origin' target='_blank' href='https://trustseal.enamad.ir/?id=8381321&Code=vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'><img referrerpolicy='origin' src='https://trustseal.enamad.ir/logo.aspx?id=8381321&Code=vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe' alt='' style='cursor:pointer' code='vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'></a>`

function OfficialSeal() {
  const imageContainer = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const image = imageContainer.current?.querySelector('img')
    if (!image) return
    const loaded = () => setStatus('loaded')
    const failed = () => setStatus('failed')
    image.addEventListener('load', loaded)
    image.addEventListener('error', failed)
    // Cached failures may complete before React attaches the listeners.
    if (image.complete) (image.naturalWidth > 0 ? loaded : failed)()
    return () => {
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
    }
  }, [attempt])

  return (
    <div className="parserver-enamad-seal">
      <div key={attempt} ref={imageContainer} className="parserver-enamad-seal__image" hidden={status !== 'loaded'} dangerouslySetInnerHTML={{ __html: PARSERVER_ENAMAD_HTML }} />
      {status !== 'loaded' && (
        <div className="parserver-enamad-seal__notice">
          <p role="status">{status === 'failed' ? 'تصویر اینماد بارگیری نشد.' : 'در حال بارگیری اینماد…'}</p>
          <a href={verificationUrl} referrerPolicy="origin" target="_blank" rel="noopener">استعلام در سامانه اینماد</a>
          {status === 'failed' && <button type="button" onClick={() => { setStatus('loading'); setAttempt(value => value + 1) }}>تلاش دوباره</button>}
        </div>
      )}
    </div>
  )
}

export function ParserverEnamadSeal({ hostname }: { hostname?: string }) {
  const currentHost = (hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).toLowerCase()
  if (currentHost !== 'parserver.ir' && currentHost !== 'www.parserver.ir') return null

  // Only a hardcoded, trusted official snippet is rendered here: no user input.
  return <OfficialSeal />
}
