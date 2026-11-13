import { createHash, timingSafeEqual } from 'node:crypto'
import { getConfig } from '../../config.js'
import { AppError } from '../../lib/errors.js'

export const validToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
export const responseCode = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : typeof value === 'string' && /^-?\d{1,8}$/.test(value) ? Number(value) : null
export const fingerprint = (merchant = getConfig().TABAPAY_MERCHANT) => createHash('sha256').update(merchant).digest('hex')
export const gatewayReady = () => getConfig().TABAPAY_ENABLED && validToken(getConfig().TABAPAY_MERCHANT)
export const paymentLink = (token: string, sandbox: boolean) => `https://api.tabapay.ir${sandbox ? '/sandbox' : ''}/pay/${token}`
export function authenticCallback(signature: unknown, merchant = getConfig().TABAPAY_MERCHANT): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{32}$/i.test(signature)) return false
  const expected = createHash('md5').update(merchant).digest('hex')
  return validToken(merchant) && timingSafeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))
}
export class GatewayRejected extends AppError {
  constructor(code: number) { super(502, [-10, -11, -30].includes(code) ? 'gateway_credential' : code === -27 ? 'gateway_domain' : 'payment_gateway_rejected',
    [-10, -11, -30].includes(code) ? 'اعتبارنامهٔ درگاه معتبر یا فعال نیست؛ با پشتیبانی تماس بگیرید.' : code === -27 ? 'دامنهٔ فروشگاه نزد درگاه تأیید نشده یا مطابقت ندارد؛ با پشتیبانی تماس بگیرید.' : 'درگاه درخواست پرداخت را نپذیرفت؛ با پشتیبانی تماس بگیرید.') }
}
export async function tabapayRequest(operation: 'create' | 'verify', fields: Record<string, string>, sandbox: boolean, credential?: string): Promise<Record<string, unknown>> {
  const config = getConfig()
  const merchant = credential ?? config.TABAPAY_MERCHANT
  if (!(credential ? validToken(merchant) : gatewayReady()) || ((config.NODE_ENV === 'production' || config.APP_ENV === 'staging') && sandbox)) {
    throw new AppError(503, 'payment_gateway_unavailable', 'درگاه پرداخت آماده نیست.')
  }
  try {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.set(key, value)
    const response = await fetch(`https://api.tabapay.ir/v1${sandbox ? '/sandbox' : ''}/${operation}`, {
      method: 'POST', headers: { Authorization: `Bearer ${merchant}`, Referer: new URL(config.FRONTEND_URL).origin + '/' }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    if (response.status >= 500 || response.status === 429) throw new Error('gateway unavailable')
    const text = await response.text()
    if (text.length > 65536) throw new Error('oversized gateway response')
    const data: unknown = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid gateway response')
    const result = data as Record<string, unknown>
    if (operation === 'create' && (responseCode(result.responseCode) ?? 0) < 0 && result.status === 'error') throw new GatewayRejected(responseCode(result.responseCode)!)
    if (!response.ok) throw new Error('gateway response failed')
    return result
  } catch (error) {
    if (error instanceof GatewayRejected) throw error
    // Never expose merchant credentials, callback tokens or issuer response text.
    throw new AppError(503, 'payment_gateway_unavailable', 'نتیجه درگاه دریافت نشد؛ وضعیت درخواست را پیگیری کنید و پرداخت جدید نسازید.')
  }
}
