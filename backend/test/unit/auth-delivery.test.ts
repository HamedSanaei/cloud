import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendParsGreenSms, sendSmsOtp } from '../../src/modules/auth/delivery.js'

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

afterEach(() => vi.unstubAllGlobals())

describe('ParsGreen SOAP delivery contract', () => {
  it('uses the new brand in login SMS without contacting a provider', async () => {
    const request = vi.fn().mockResolvedValue(new Response('<SendGroupSMSResult>1</SendGroupSMSResult>'))
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
    expect(options.headers.soapaction).toBe('http://tempuri.org/SendGroupSMS')
    expect(options.body).toContain('<retStr />')
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
  })
})
