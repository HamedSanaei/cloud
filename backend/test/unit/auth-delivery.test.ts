import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendParsGreenSms, sendSmsOtp } from '../../src/modules/auth/delivery.js'
import { isDomainBoundLoginPattern } from '../../src/modules/auth/sms-autofill.js'

const { warn, smsConfig } = vi.hoisted(() => ({ warn: vi.fn(), smsConfig: { pattern: '', primary: '9998883511', mode: 'live' as 'live' | 'log' } }))
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ warn }) }))

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    NODE_ENV: 'test',
    AUTH_DELIVERY_MODE: smsConfig.mode,
    PARSGREEN_SIGNATURE: 'fixture-signature<&>',
    PARSGREEN_PRIMARY_FROM: smsConfig.primary,
    PARSGREEN_FROM: 'fixture-sender',
    PARSGREEN_ENDPOINT: 'https://login.parsgreen.com/Api/SendSMS.asmx',
    PARSGREEN_TIMEOUT_MS: 1000,
    PARSGREEN_APPROVED_PHONE_LOGIN_PATTERN: smsConfig.pattern,
    FRONTEND_URL: 'https://login.example.test/login',
  }),
  isProduction: () => false,
}))

afterEach(() => { smsConfig.pattern = ''; smsConfig.primary = '9998883511'; smsConfig.mode = 'live'; vi.unstubAllGlobals(); vi.clearAllMocks() })

const accepted = '<SendGroupSMSResponse xmlns="http://ParsGreen.com/"><SendGroupSMSResult>1</SendGroupSMSResult><success>1</success><retStr><string>fixture-message-id</string></retStr></SendGroupSMSResponse>'

describe('dedicated service line priority', () => {
  it('sends arbitrary service SMS on the primary line and never contacts the legacy line on success', async () => {
    const request = vi.fn().mockResolvedValue(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'Fixture service notice')).resolves.toEqual({})
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1].body).toContain('<from>9998883511</from>')
    expect(request.mock.calls[0]![1].body).toContain('<text>Fixture service notice</text>')
    expect(request.mock.calls[0]![1].body).not.toContain('<from>fixture-sender</from>')
  })

  it.each(['rejection', 'HTTP failure', 'timeout', 'malformed response'])('falls back once after %s using the same recipient/code and the old approved pattern', async reason => {
    smsConfig.pattern = 'Approved fallback: %%\n@login.example.test #%%'
    const request = vi.fn()
    if (reason === 'timeout') request.mockRejectedValueOnce(new DOMException('fixture timeout', 'TimeoutError'))
    else request.mockResolvedValueOnce(new Response(reason === 'rejection' ? '<SendGroupSMSResult>1</SendGroupSMSResult><success>0</success>' : 'Unavailable', { status: reason === 'HTTP failure' ? 503 : 200 }))
    request.mockResolvedValueOnce(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', 'https://login.example.test')).resolves.toEqual({ smsAutofill: true })
    expect(request).toHaveBeenCalledTimes(2)
    const first = request.mock.calls[0]![1].body, fallback = request.mock.calls[1]![1].body
    expect(first).toContain('<from>9998883511</from>')
    expect(first).not.toContain('Approved fallback:')
    expect(fallback).toContain('<from>fixture-sender</from>')
    expect(fallback).toContain('<text>Approved fallback: 034567\n@login.example.test #034567</text>')
    for (const body of [first, fallback]) expect(body).toContain('<to><string>09000000000</string></to>')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/034567|09000000000|fixture-signature/)
  })

  it('keeps the previous manual OTP fallback when no approved login pattern is configured', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '123456')).resolves.toEqual({})
    expect(request.mock.calls[1]![1].body).toContain('<from>fixture-sender</from>')
    expect(request.mock.calls[1]![1].body).toContain('کد ورود پارس سرور: 123456')
  })

  it('preserves a service notification message when the legacy sender is needed', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('primary unavailable')).mockResolvedValueOnce(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'Fixture service notice')).resolves.toEqual({})
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![1].body).toContain('<from>fixture-sender</from>')
    for (const [, options] of request.mock.calls) expect(options.body).toContain('<text>Fixture service notice</text>')
  })

  it('does not retry the same sender or send a third message', async () => {
    smsConfig.primary = 'fixture-sender'
    const request = vi.fn().mockRejectedValue(new Error('unavailable'))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'fixture')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid recipient before either send and keeps log mode offline', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('invalid', 'fixture')).rejects.toThrow('شماره همراه ایرانی معتبر نیست')
    expect(request).not.toHaveBeenCalled()
    smsConfig.mode = 'log'
    await expect(sendSmsOtp('+989000000000', '034567')).resolves.toEqual({ developmentCode: '034567' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('domain-bound login SMS', () => {
  const pattern = 'Sample code: %%\n@login.example.test #%%'

  it('sends the same issued code in both slots with the domain on the exact last line', async () => {
    smsConfig.pattern = pattern
    const request = vi.fn().mockResolvedValue(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', 'https://login.example.test')).resolves.toEqual({ smsAutofill: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1].body).toContain('<from>9998883511</from>')
    expect(request.mock.calls[0]![1].body).toContain('کد ورود پارس سرور: 034567')
    expect(request.mock.calls[0]![1].body).toContain('\n@login.example.test #034567</text>')
    expect(request.mock.calls[0]![1].body).not.toContain('Sample code:')
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['https://example.test', 'https://login.example.test:444', undefined])('uses manual SMS for origin %s', async (origin) => {
    smsConfig.pattern = pattern
    const request = vi.fn().mockResolvedValue(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', origin)).resolves.toEqual({})
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1].body).toContain('کد ورود پارس سرور: 034567')
    expect(request.mock.calls[0]![1].body).not.toContain('@login.example.test')
  })

  it.each([
    [pattern, 'https://login.example.test/login', true],
    [pattern, 'https://example.test/login', false],
    [pattern, 'http://login.example.test/login', false],
    [pattern + '\n', 'https://login.example.test/login', false],
    [pattern.replace(' #%%', ' #123456'), 'https://login.example.test/login', false],
    [pattern.replace('code: %%', 'code: 123456'), 'https://login.example.test/login', false],
  ])('validates the dynamic pattern and canonical origin', (text, origin, valid) => {
    expect(isDomainBoundLoginPattern(text, origin)).toBe(valid)
  })

  it('tries the approved legacy pattern once after primary rejection without exposing the code', async () => {
    smsConfig.pattern = pattern
    const request = vi.fn().mockResolvedValue(new Response('<Fault>fixture-signature 09000000000 034567</Fault>'))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', 'https://login.example.test')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![1].body).toContain('<from>fixture-sender</from>')
    expect(request.mock.calls[1]![1].body).toContain('<text>Sample code: 034567\n@login.example.test #034567</text>')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-signature|09000000000|034567/)
  })
})

describe('ParsGreen SOAP delivery contract', () => {
  it('uses the new brand in login SMS without contacting a provider', async () => {
    const request = vi.fn().mockResolvedValue(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await sendSmsOtp('+989000000000', '123456')
    expect(request.mock.calls[0]![1].body).toContain('کد ورود پارس سرور: 123456')
    expect(request.mock.calls[0]![1].body).not.toContain('سرورهاب')
  })
  it('uses an empty ArrayOfString for retStr, not an array of long', async () => {
    // https://login.parsgreen.com/Api/SendSMS.asmx?WSDL declares
    // SendGroupSMS.retStr as tns:ArrayOfString (an output/reference argument).
    const request = vi.fn().mockResolvedValue(new Response(
      '<SendGroupSMSResponse><SendGroupSMSResult>1</SendGroupSMSResult><success>1</success><retStr><string>fixture-message-id</string></retStr></SendGroupSMSResponse>',
    ))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'fixture <code> & text')).resolves.toEqual({})
    const [url, options] = request.mock.calls[0]!
    expect(String(url)).toBe('https://login.parsgreen.com/Api/SendSMS.asmx')
    expect(options.headers.soapaction).toBe('"http://ParsGreen.com/SendGroupSMS"')
    expect(options.body).toContain('<SendGroupSMS xmlns="http://ParsGreen.com/">')
    expect(options.body).not.toContain('tempuri.org')
    expect(options.body).toContain('<retStr />')
    expect(options.body).toContain('<to><string>09000000000</string></to>')
    expect(options.body).not.toContain('<long>')
    expect(options.body).toContain('fixture-signature&lt;&amp;&gt;')
    expect(options.body).toContain('fixture &lt;code&gt; &amp; text')
  })

  it('does not leak provider responses or credentials when a delivery is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<SendGroupSMSResult>0</SendGroupSMSResult>fixture-private-response',
    )))
    const error = await sendParsGreenSms('+989000000000', 'fixture').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('fixture-private-response')
    expect(String(error)).not.toContain('fixture-signature')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-response')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-signature')
  })

  it('records safe diagnostics for the production SOAPAction fault without exposing the raw response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Server did not recognize the value of HTTP Header SOAPAction: http://tempuri.org/SendGroupSMS. fixture-signature&lt;&amp;&gt; 09000000000 123456</faultstring></soap:Fault>',
      { status: 500 },
    )))
    await expect(sendSmsOtp('+989000000000', '123456')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(warn).toHaveBeenCalledWith({ reason: 'soap_fault', httpStatus: 500, providerResult: null, acceptedCount: null, senderRoute: 'primary' }, 'ParsGreen delivery failed')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-signature|09000000000|123456|tempuri/)
  })

  it.each([
    ['zero accepted recipients', '<SendGroupSMSResult>1</SendGroupSMSResult><success>0</success>'],
    ['missing acceptance count', '<SendGroupSMSResult>1</SendGroupSMSResult>'],
    ['rejected result', '<SendGroupSMSResult>-1</SendGroupSMSResult><success>1</success>'],
    ['non-SOAP response', '<html>Unavailable</html>'],
  ])('does not report success for %s', async (_label, body) => {
    const request = vi.fn().mockImplementation(async () => new Response(body))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'fixture')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('accepts namespace-prefixed numeric result fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<pg:SendGroupSMSResponse xmlns:pg="http://ParsGreen.com/"><pg:SendGroupSMSResult> 1 </pg:SendGroupSMSResult><pg:success>1</pg:success></pg:SendGroupSMSResponse>',
    )))
    await expect(sendParsGreenSms('+989000000000', 'fixture')).resolves.toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not leak a timeout and limits failover to one legacy attempt', async () => {
    const request = vi.fn().mockRejectedValue(new Error('fixture-private-response fixture-signature 123456'))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '123456')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith({ reason: 'transport_failure', senderRoute: 'primary' }, 'ParsGreen delivery failed')
    expect(warn).toHaveBeenCalledWith({ reason: 'transport_failure', senderRoute: 'fallback' }, 'ParsGreen delivery failed')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-private|fixture-signature|123456/)
  })
})
