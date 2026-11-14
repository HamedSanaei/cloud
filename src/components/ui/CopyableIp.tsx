import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

function isIp(value: string) {
  const [address = '', prefix, extra] = value.split('/')
  if (address === '0.0.0.0') return false
  const ipv6 = address.includes(':')
  if (extra !== undefined || (prefix !== undefined && (!/^[0-9]{1,3}$/.test(prefix) || Number(prefix) > (ipv6 ? 128 : 32)))) return false
  if (!ipv6) {
    const octets = address.split('.')
    return octets.length === 4 && octets.every(octet => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
  }
  if (!/^[a-f0-9:.]+$/i.test(address)) return false
  try {
    const host = new URL(`http://[${address}]/`).hostname
    return host.startsWith('[') && host !== '[::]'
  } catch { return false }
}

export function CopyableIp({ value }: { value?: string | null }) {
  return value && isIp(value) ? <IpCopyButton key={value} value={value} /> : <span className="copyable-ip__missing">در دسترس نیست</span>
}

function IpCopyButton({ value }: { value: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle')
  const fallback = useRef<HTMLInputElement>(null)
  const timeout = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (status === 'manual') { fallback.current?.focus(); fallback.current?.select() }
  }, [status])
  useEffect(() => () => window.clearTimeout(timeout.current), [])

  return <span className="copyable-ip">
    <button type="button" className="copyable-ip__button" dir="ltr" aria-label={`کپی آی‌پی ${value}`} onClick={async event => {
      event.stopPropagation()
      window.clearTimeout(timeout.current)
      try {
        await navigator.clipboard.writeText(value)
        window.clearTimeout(timeout.current)
        setStatus('copied')
        timeout.current = window.setTimeout(() => setStatus('idle'), 2200)
      }
      catch { setStatus('manual'); fallback.current?.focus(); fallback.current?.select() }
    }}>
      <bdi dir="ltr">{value}</bdi>
      {status === 'copied' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
    </button>
    <span role="status" className="copyable-ip__status">
      {status === 'copied' ? 'آی‌پی کپی شد' : status === 'manual' ? 'کپی خودکار ممکن نبود. آدرس انتخاب‌شده را دستی کپی کنید.' : ''}
    </span>
    {status === 'manual' && <input className="copyable-ip__fallback" dir="ltr" ref={fallback} readOnly value={value} aria-label="آدرس آی‌پی برای کپی دستی"
      onClick={event => { event.stopPropagation(); event.currentTarget.select() }} />}
  </span>
}
