export function ParserverTabaPaySeal() {
  const host = typeof window === 'undefined' ? '' : window.location.hostname
  if (host !== 'parserver.ir' && host !== 'www.parserver.ir') return null

  return (
    <iframe
      className="parserver-tabapay-seal"
      title="نماد اعتماد تاباپی"
      src="/tabapay-trust.html"
      loading="lazy"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="origin"
    />
  )
}
