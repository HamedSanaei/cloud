import nodemailer from 'nodemailer'
import { getConfig, isProduction } from '../../config.js'
import { ProviderPermanentError, ProviderRetryableError } from '../../lib/errors.js'

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
    login: 'کد ورود به سرورهاب',
    register: 'تأیید ایمیل سرورهاب',
    recovery: 'بازیابی رمز عبور سرورهاب',
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
  <soap:Body><SendGroupSMS xmlns="http://tempuri.org/">
    <signature>${xmlEscape(config.PARSGREEN_SIGNATURE)}</signature>
    <from>${xmlEscape(config.PARSGREEN_FROM)}</from>
    <to><string>${xmlEscape(to)}</string></to>
    <text>${xmlEscape(message)}</text><isFlash>false</isFlash><udh></udh><success>0</success><retStr><long>0</long></retStr>
  </SendGroupSMS></soap:Body>
</soap:Envelope>`
  try {
    const response = await fetch(config.PARSGREEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: 'http://tempuri.org/SendGroupSMS' },
      body: envelope,
      signal: AbortSignal.timeout(config.PARSGREEN_TIMEOUT_MS),
    })
    const body = await response.text()
    const result = body.match(/<SendGroupSMSResult>([^<]+)<\/SendGroupSMSResult>/)?.[1]
    if (!response.ok || result !== '1') throw new Error('provider rejected message')
    return {}
  } catch (error) {
    if (error instanceof ProviderPermanentError) throw error
    throw new ProviderRetryableError('ارسال پیامک ناموفق بود؛ کمی بعد دوباره تلاش کنید')
  }
}

export async function sendSmsOtp(to: string, code: string): Promise<{ developmentCode?: string }> {
  return sendParsGreenSms(to, `کد ورود سرورهاب: ${code}\nاین کد را در اختیار دیگران قرار ندهید.`)
}
