export function ParserverTabaPaySeal() {
  const host = typeof window === 'undefined' ? '' : window.location.hostname
  if (host !== 'parserver.ir' && host !== 'www.parserver.ir') return null

  return (
    <div className="parserver-tabapay-seal">
      <iframe
        title="نماد اعتماد تاباپی"
        src="/tabapay-trust.html"
        loading="lazy"
        sandbox="allow-scripts"
        referrerPolicy="origin"
        tabIndex={-1}
        aria-hidden="true"
      />
      <a
        className="parserver-tabapay-seal__link"
        href="https://tabapay.ir/payments/trust/parserver.ir"
        target="_blank"
        rel="noopener"
        referrerPolicy="origin"
        aria-label="استعلام نماد اعتماد تاباپی پارس سرور"
      />
    </div>
  )
}
