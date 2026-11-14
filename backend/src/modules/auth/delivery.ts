import nodemailer from 'nodemailer'
import { getConfig, isProduction } from '../../config.js'
import { ProviderPermanentError, ProviderRetryableError } from '../../lib/errors.js'
import { createLogger } from '../../logger.js'

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

export function normalizeIranMobile(value: string): string | null {
  const ascii = value
    .trim()
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[\s()-]/g, '')
  if (/^09\d{9}$/.test(ascii)) return `+98${ascii.slice(1)}`
  if (/^989\d{9}$/.test(ascii)) return `+${ascii}`
  if (/^\+989\d{9}$/.test(ascii)) return ascii
  return null
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

export async function sendEmailOtp(to: string, code: string, purpose: 'login' | 'register' | 'recovery'): Promise<{ developmentCode?: string }> {
  const config = getConfig()
  if (config.AUTH_DELIVERY_MODE === 'log') {
    if (isProduction()) throw new ProviderPermanentError('ارسال ایمیل در محیط عملیاتی پیکربندی نشده است')
    return { developmentCode: code }
  }
  if (!config.SMTP_HOST) throw new ProviderPermanentError('تنظیمات SMTP کامل نیست')

  const titles = {
    login: 'کد ورود به پارس سرور',
    register: 'تأیید ایمیل پارس سرور',
    recovery: 'بازیابی رمز عبور پارس سرور',
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  })
  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to,
      subject: titles[purpose],
      text: `کد تأیید شما: ${code}\nاین کد تا ${Math.ceil(config.AUTH_OTP_TTL_SECONDS / 60)} دقیقه معتبر است.`,
      html: `<div dir="rtl" style="font-family:Tahoma,sans-serif"><h2>${titles[purpose]}</h2><p>کد تأیید شما:</p><p style="font-size:30px;letter-spacing:8px;font-weight:bold" dir="ltr">${code}</p><p>این کد تا ${Math.ceil(config.AUTH_OTP_TTL_SECONDS / 60)} دقیقه معتبر است.</p></div>`,
    })
    return {}
  } catch {
    throw new ProviderRetryableError('ارسال ایمیل ناموفق بود؛ کمی بعد دوباره تلاش کنید')
  }
}

export async function sendParsGreenSms(to: string, message: string): Promise<{ developmentCode?: string }> {
  const config = getConfig()
  if (config.AUTH_DELIVERY_MODE === 'log') {
    if (isProduction()) throw new ProviderPermanentError('ارسال پیامک در محیط عملیاتی پیکربندی نشده است')
    const developmentCode = message.match(/\b(\d{6})\b/)?.[1]
    return developmentCode ? { developmentCode } : {}
  }
  if (!config.PARSGREEN_SIGNATURE || !config.PARSGREEN_FROM) {
    throw new ProviderPermanentError('تنظیمات سرویس پیامکی ParsGreen کامل نیست')
  }

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><SendGroupSMS xmlns="${PARSGREEN_SOAP_NAMESPACE}">
    <signature>${xmlEscape(config.PARSGREEN_SIGNATURE)}</signature>
    <from>${xmlEscape(config.PARSGREEN_FROM)}</from>
    <to><string>${xmlEscape(parsGreenRecipient(to))}</string></to>
    <text>${xmlEscape(message)}</text><isFlash>false</isFlash><udh></udh><success>0</success><retStr />
  </SendGroupSMS></soap:Body>
</soap:Envelope>`
  let diagnostics: { reason: string; httpStatus?: number; providerResult?: number | null; acceptedCount?: number | null } = { reason: 'transport_failure' }
  try {
    const response = await fetch(config.PARSGREEN_ENDPOINT, {
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
    return {}
  } catch (error) {
    // Never log the envelope, response, recipient, OTP, credentials or raw
    // exception: SOAP faults may echo the entire authenticated request.
    createLogger('sms-delivery').warn(diagnostics, 'ParsGreen delivery failed')
    if (error instanceof ProviderPermanentError) throw error
    throw new ProviderRetryableError('ارسال پیامک ناموفق بود؛ کمی بعد دوباره تلاش کنید')
  }
}

export async function sendSmsOtp(to: string, code: string, loginOrigin?: string): Promise<{ developmentCode?: string; smsAutofill?: true }> {
  const config = getConfig()
  const pattern = config.PARSGREEN_APPROVED_PHONE_LOGIN_PATTERN
  if (pattern && config.AUTH_DELIVERY_MODE === 'live' && loginOrigin === new URL(config.FRONTEND_URL).origin) {
    await sendParsGreenSms(to, pattern.replaceAll('%%', code))
    return { smsAutofill: true }
  }
  return sendParsGreenSms(to, `کد ورود پارس سرور: ${code}\nاین کد را در اختیار دیگران قرار ندهید.`)
}
