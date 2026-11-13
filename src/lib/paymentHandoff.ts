const TABAPAY_GATEWAY_ORIGIN = 'https://api.tabapay.ir'
const TABAPAY_PAYMENT_PATH = /^\/(?:sandbox\/)?pay\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Navigates via a first-party HTTPS document to preserve the merchant origin. */
export function firstPartyTabapayHandoff(paymentUrl: string): string {
  const url = new URL(paymentUrl)
  if (url.origin !== TABAPAY_GATEWAY_ORIGIN || !TABAPAY_PAYMENT_PATH.test(url.pathname) || url.search || url.hash) {
    throw new Error('لینک پرداخت تاباپی معتبر نیست.')
  }
  return '/payment-continue.html#' + url.pathname.slice(1).toLowerCase()
}
