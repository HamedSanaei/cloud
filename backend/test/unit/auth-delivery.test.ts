import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendParsGreenSms, sendSmsOtp } from '../../src/modules/auth/delivery.js'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ warn }) }))

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    AUTH_DELIVERY_MODE: 'live',
    PARSGREEN_SIGNATURE: 'fixture-signature<&>',
    PARSGREEN_FROM: 'fixture-sender',
    PARSGREEN_ENDPOINT: 'https://sms.example.test/service',
    PARSGREEN_TIMEOUT_MS: 1000,
  }),
  isProduction: () => false,
}))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const accepted = '<SendGroupSMSResponse xmlns="http://ParsGreen.com/"><SendGroupSMSResult>1</SendGroupSMSResult><success>1</success><retStr><string>fixture-message-id</string></retStr></SendGroupSMSResponse>'

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
