import { getConfig, isProduction } from '../../config.js'
import { ProviderPermanentError, ProviderRetryableError, ProviderUnknownError } from '../../lib/errors.js'
import { createLogger } from '../../logger.js'
import { openSmtp, outboundFetch } from '../outbound/client.js'
import { smtpTransport } from '../outbound/smtp.js'
import { smsSegments } from './parsgreen-templates.js'
import { normalizeIranMobile } from '../../contracts/iran-mobile.js'
import { internalEmail } from './email-address.js'
export { normalizeIranMobile } from '../../contracts/iran-mobile.js'

// SOAP 1.1 contract published by /Api/SendSMS.asmx?op=SendGroupSMS.
const PARSGREEN_SOAP_NAMESPACE = 'http://ParsGreen.com/'

function soapInteger(body: string, name: 'SendGroupSMSResult' | 'success'): number | null {
  const value = body.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>\\s*(-?\\d+)\\s*</(?:[\\w.-]+:)?${name}>`))?.[1]
  if (value === undefined) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'\"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!)
}

export function parsGreenRecipient(value: string): string {
  const normalized = normalizeIranMobile(value)
  if (!normalized) throw new ProviderPermanentError('شماره همراه ایرانی معتبر نیست')
  return '0' + normalized.slice(3)
}

export function maskMobile(e164: string): string {
  return `09${e164.slice(4, 7)}***${e164.slice(-3)}`
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`
}

export async function sendEmailOtp(to: string, code: string, purpose: 'login' | 'register' | 'recovery' | 'operation' | 'account', expiresIn?: number): Promise<{ developmentCode?: string }> {
  if (internalEmail(to)) throw new ProviderPermanentError('آدرس ایمیل قابل ارسال نیست')
  const config = getConfig()
  if (config.AUTH_DELIVERY_MODE === 'log') {
    if (isProduction()) throw new ProviderPermanentError('ارسال ایمیل در محیط عملیاتی پیکربندی نشده است')
    return { developmentCode: code }
  }
  if (!config.SMTP_HOST) throw new ProviderPermanentError('تنظیمات SMTP کامل نیست')

  const titles = {
    login: 'کد ورود به پارس سرور',
    register: 'تأیید ایمیل پارس سرور',
    account: 'تأیید آدرس ایمیل حساب پارس سرور',
    recovery: 'بازیابی رمز عبور پارس سرور',
    operation: 'کد تأیید عملیات سرور پارس سرور',
  }
  const validity = `این کد تا ${Math.ceil((expiresIn ?? config.AUTH_OTP_TTL_SECONDS) / 60)} دقیقه معتبر است.`
  let connection: Awaited<ReturnType<typeof openSmtp>>['socket']
  try {
    const route = await openSmtp(config.SMTP_HOST, config.SMTP_PORT, config.SMTP_SECURE)
    connection = route.socket
    const transport = smtpTransport(config, connection)
    await transport.sendMail({
      from: config.SMTP_FROM,
      to,
      subject: titles[purpose],
      text: `کد تأیید شما: ${code}\n${validity}`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="background:#f1f5fb;font-family:Tahoma,Arial,sans-serif;color:#172842">
        <tr><td align="center" style="padding:24px 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:1px solid #d9e3f0;border-radius:16px">
            <tr><td align="center" dir="rtl" style="padding:24px 16px;line-height:1.8">
              <p style="margin:0;color:#1751a0;font-size:15px;font-weight:bold">پارس‌سرور</p>
              <h1 style="margin:8px 0 4px;font-size:20px">${titles[purpose]}</h1>
              <p style="margin:0;font-size:14px">کد زیر را در پنل وارد کنید.</p>
              <p style="margin:16px 0;color:#123e7c;background:#edf4ff;border-radius:10px;padding:10px 6px;text-align:center"><bdo dir="ltr" style="font-family:Arial,sans-serif;font-size:32px;letter-spacing:4px">${code}</bdo></p>
              <p style="margin:0;color:#475569;font-size:13px">${validity}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>`,
    })
    return {}
  } catch {
    connection?.destroy()
    throw new ProviderRetryableError('ارسال ایمیل ناموفق بود؛ کمی بعد دوباره تلاش کنید')
  }
}

export async function sendParsGreenSms(to: string, message: string, options: { stopOnUnknown?: boolean } = {}): Promise<{ developmentCode?: string }> {
  return sendSmsWithFallback(to, message, () => message, options.stopOnUnknown)
}

async function sendSmsWithFallback(to: string, message: string, fallbackMessage: () => string, stopOnUnknown = false): Promise<{ developmentCode?: string }> {
  const config = getConfig()
  if (config.AUTH_DELIVERY_MODE === 'log') {
    if (isProduction()) throw new ProviderPermanentError('ارسال پیامک در محیط عملیاتی پیکربندی نشده است')
    const developmentCode = message.match(/\b(\d{6})\b/)?.[1]
    return developmentCode ? { developmentCode } : {}
  }
  if (!config.PARSGREEN_SIGNATURE || !config.PARSGREEN_FROM) {
    throw new ProviderPermanentError('تنظیمات سرویس پیامکی ParsGreen کامل نیست')
  }
  const recipient = parsGreenRecipient(to)
  try {
    await sendSmsFrom(recipient, message, config.PARSGREEN_PRIMARY_FROM, 'primary')
  } catch (error) {
    if (stopOnUnknown && error instanceof ProviderUnknownError) throw error
    // One bounded failover, not another OTP/challenge or a retry loop.
    if (config.PARSGREEN_PRIMARY_FROM === config.PARSGREEN_FROM) throw error
    await sendSmsFrom(recipient, fallbackMessage(), config.PARSGREEN_FROM, 'fallback')
  }
  return {}
}

async function sendSmsFrom(recipient: string, message: string, sender: string, senderRoute: 'primary' | 'fallback'): Promise<void> {
  const config = getConfig()
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><SendGroupSMS xmlns="${PARSGREEN_SOAP_NAMESPACE}">
    <signature>${xmlEscape(config.PARSGREEN_SIGNATURE)}</signature>
    <from>${xmlEscape(sender)}</from>
    <to><string>${xmlEscape(recipient)}</string></to>
    <text>${xmlEscape(message)}</text><isFlash>false</isFlash><udh></udh><success>0</success><retStr />
  </SendGroupSMS></soap:Body>
</soap:Envelope>`
  let diagnostics: { reason: string; httpStatus?: number; providerResult?: number | null; acceptedCount?: number | null } = { reason: 'transport_failure' }
  try {
    const response = await outboundFetch('parsgreen', config.PARSGREEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${PARSGREEN_SOAP_NAMESPACE}SendGroupSMS"` },
      body: envelope,
      signal: AbortSignal.timeout(config.PARSGREEN_TIMEOUT_MS),
    })
    const body = await response.text()
    const fault = /<(?:[\w.-]+:)?Fault(?:\s|>)/.test(body)
    diagnostics = {
      reason: fault ? 'soap_fault' : 'provider_rejected',
      httpStatus: response.status,
      providerResult: soapInteger(body, 'SendGroupSMSResult'),
      acceptedCount: soapInteger(body, 'success'),
    }
    // One requested recipient must be accepted. Transport acceptance is not a
    // handset delivery receipt; result=1 alone can still have success=0.
    if (!response.ok || fault || diagnostics.providerResult !== 1 || diagnostics.acceptedCount !== 1) {
      throw new Error('provider rejected message')
    }
    createLogger('sms-delivery').info({ senderRoute, status: 'accepted', ...smsSegments(message) }, 'ParsGreen accepted SMS (not a handset receipt)')
    return
  } catch (error) {
    // Never log the envelope, response, recipient, OTP, credentials or raw
    // exception: SOAP faults may echo the entire authenticated request.
    createLogger('sms-delivery').warn({ ...diagnostics, senderRoute, ...smsSegments(message) }, 'ParsGreen delivery failed')
    if (error instanceof ProviderPermanentError) throw error
    if (diagnostics.reason === 'transport_failure' || diagnostics.providerResult === null || diagnostics.acceptedCount === null) throw new ProviderUnknownError('ارسال پیامک ناموفق بود؛ وضعیت پذیرش نامشخص است')
    throw new ProviderRetryableError('ارسال پیامک ناموفق بود؛ کمی بعد دوباره تلاش کنید')
  }
}

export async function sendSmsOtp(to: string, code: string, loginOrigin?: string): Promise<{ developmentCode?: string; smsAutofill?: true }> {
  const config = getConfig()
  const frontendHost = new URL(config.FRONTEND_URL).hostname
  const pattern = frontendHost === 'parserver.ir' ? 'پارس سرور: کد ورود %%؛ محرمانه\n@parserver.ir #%%' : config.PARSGREEN_APPROVED_PHONE_LOGIN_PATTERN
  const directMessage = `کد ورود پارس سرور: ${code}\nاین کد را در اختیار دیگران قرار ندهید.`
  if (pattern && config.AUTH_DELIVERY_MODE === 'live' && loginOrigin === new URL(config.FRONTEND_URL).origin) {
    const host = new URL(config.FRONTEND_URL).hostname
    // The dedicated line gets direct text, never a legacy template. Render the
    // already-approved legacy pattern only if that primary attempt fails.
    const compact = host === 'parserver.ir' ? `پارس سرور: کد ورود ${code}؛ محرمانه\n@${host} #${code}` : `${directMessage}\n@${host} #${code}`
    await sendSmsWithFallback(to, compact, () => pattern.replaceAll('%%', code))
    return { smsAutofill: true }
  }
  if (frontendHost === 'parserver.ir' && config.AUTH_DELIVERY_MODE === 'live') return sendSmsWithFallback(to, directMessage, () => pattern.replaceAll('%%', code))
  return sendParsGreenSms(to, directMessage)
}
