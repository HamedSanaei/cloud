import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendParsGreenSms, sendSmsOtp } from '../../src/modules/auth/delivery.js'
import { isDomainBoundLoginPattern } from '../../src/modules/auth/sms-autofill.js'

const { warn, smsConfig } = vi.hoisted(() => ({ warn: vi.fn(), smsConfig: { pattern: '' } }))
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ warn }) }))

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    AUTH_DELIVERY_MODE: 'live',
    PARSGREEN_SIGNATURE: 'fixture-signature<&>',
    PARSGREEN_FROM: 'fixture-sender',
    PARSGREEN_ENDPOINT: 'https://sms.example.test/service',
    PARSGREEN_TIMEOUT_MS: 1000,
    PARSGREEN_APPROVED_PHONE_LOGIN_PATTERN: smsConfig.pattern,
    FRONTEND_URL: 'https://login.example.test/login',
  }),
  isProduction: () => false,
}))

afterEach(() => { smsConfig.pattern = ''; vi.unstubAllGlobals(); vi.clearAllMocks() })

const accepted = '<SendGroupSMSResponse xmlns="http://ParsGreen.com/"><SendGroupSMSResult>1</SendGroupSMSResult><success>1</success><retStr><string>fixture-message-id</string></retStr></SendGroupSMSResponse>'

describe('domain-bound login SMS', () => {
  const pattern = 'Sample code: %%\n@login.example.test #%%'

  it('sends the same issued code in both slots with the domain on the exact last line', async () => {
    smsConfig.pattern = pattern
    const request = vi.fn().mockResolvedValue(new Response(accepted))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', 'https://login.example.test')).resolves.toEqual({ smsAutofill: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1].body).toContain('<text>Sample code: 034567\n@login.example.test #034567</text>')
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

  it('does not send an extra fallback SMS or expose the code on rejection', async () => {
    smsConfig.pattern = pattern
    const request = vi.fn().mockResolvedValue(new Response('<Fault>fixture-signature 09000000000 034567</Fault>'))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '034567', 'https://login.example.test')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(1)
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
    expect(url).toBe('https://sms.example.test/service')
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
    expect(warn).toHaveBeenCalledWith({ reason: 'soap_fault', httpStatus: 500, providerResult: null, acceptedCount: null }, 'ParsGreen delivery failed')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-signature|09000000000|123456|tempuri/)
  })

  it.each([
    ['zero accepted recipients', '<SendGroupSMSResult>1</SendGroupSMSResult><success>0</success>'],
    ['missing acceptance count', '<SendGroupSMSResult>1</SendGroupSMSResult>'],
    ['rejected result', '<SendGroupSMSResult>-1</SendGroupSMSResult><success>1</success>'],
    ['non-SOAP response', '<html>Unavailable</html>'],
  ])('does not report success for %s', async (_label, body) => {
    const request = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', request)
    await expect(sendParsGreenSms('+989000000000', 'fixture')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('accepts namespace-prefixed numeric result fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<pg:SendGroupSMSResponse xmlns:pg="http://ParsGreen.com/"><pg:SendGroupSMSResult> 1 </pg:SendGroupSMSResult><pg:success>1</pg:success></pg:SendGroupSMSResponse>',
    )))
    await expect(sendParsGreenSms('+989000000000', 'fixture')).resolves.toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not leak or automatically retry a timeout after dispatch', async () => {
    const request = vi.fn().mockRejectedValue(new Error('fixture-private-response fixture-signature 123456'))
    vi.stubGlobal('fetch', request)
    await expect(sendSmsOtp('+989000000000', '123456')).rejects.toThrow('ارسال پیامک ناموفق بود')
    expect(request).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith({ reason: 'transport_failure' }, 'ParsGreen delivery failed')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-private|fixture-signature|123456/)
  })
})
