import type { CSSProperties } from 'react'

// The eNamad-issued snippet must remain byte-for-byte unchanged.
export const PARSERVER_ENAMAD_HTML = `<a referrerpolicy='origin' target='_blank' href='https://trustseal.enamad.ir/?id=8381321&Code=vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'><img referrerpolicy='origin' src='https://trustseal.enamad.ir/logo.aspx?id=8381321&Code=vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe' alt='' style='cursor:pointer' code='vjF6ISz8Uxq8wxJBmjcMt1su8BMySoWe'></a>`

const wrapperStyle: CSSProperties = { display: 'inline-block' }

export function ParserverEnamadSeal({ hostname }: { hostname?: string }) {
  const currentHost = (hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname)).toLowerCase()
  if (currentHost !== 'parserver.ir' && currentHost !== 'www.parserver.ir') return null

  // Only a hardcoded, trusted official snippet is rendered here: no user input.
  return <div className="parserver-enamad-seal" style={wrapperStyle} dangerouslySetInnerHTML={{ __html: PARSERVER_ENAMAD_HTML }} />
}
