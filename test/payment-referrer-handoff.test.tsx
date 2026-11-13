import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { firstPartyTabapayHandoff } from '../src/lib/paymentHandoff'

const token = '22222222-2222-4222-8222-222222222222'
const html = readFileSync(join(process.cwd(), 'public/payment-continue.html'), 'utf8')
const code = readFileSync(join(process.cwd(), 'public/payment-continue.js'), 'utf8')

function navigate(fragment: string) {
  let redirected: string | null = null
  const status = { textContent: '' }
  const link = { href: '', hidden: true }
  const document = { getElementById: (id: string) => id === 'status' ? status : id === 'continue' ? link : null }
  const window = { location: { hash: fragment, replace: (url: string) => { redirected = url } } }
  runInNewContext(code, { document, window })
  return { redirected, status, link }
}

describe('TabaPay same-origin browser handoff', () => {
  it('keeps the token in a URL fragment and rejects arbitrary redirect targets', () => {
    expect(firstPartyTabapayHandoff('https://api.tabapay.ir/pay/' + token)).toBe('/payment-continue.html#pay/' + token)
    expect(firstPartyTabapayHandoff('https://api.tabapay.ir/sandbox/pay/' + token)).toBe('/payment-continue.html#sandbox/pay/' + token)
    for (const url of [
      'https://evil.test/pay/' + token,
      'http://api.tabapay.ir/pay/' + token,
      'https://api.tabapay.ir/pay/' + token + '?continue=https://evil.test',
      'https://api.tabapay.ir/pay/' + token + '#evil',
      'https://api.tabapay.ir.evil.test/pay/' + token,
      'https://api.tabapay.ir/pay/not-a-uuid',
    ]) expect(() => firstPartyTabapayHandoff(url)).toThrow()
  })

  it('sets an explicit origin-only Referer policy in the first-party document', () => {
    expect(html).toContain('<meta name="referrer" content="origin">')
    expect(html).toContain('referrerpolicy="origin"')
    expect(html).toContain('src="/payment-continue.js"')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('no-referrer')
    expect(html).not.toContain('noreferrer')
  })

  it('navigates only to an HTTPS TabaPay payment endpoint in the same tab', () => {
    const result = navigate('#pay/' + token)
    expect(result.redirected).toBe('https://api.tabapay.ir/pay/' + token)
    expect(result.link.href).toBe(result.redirected)
    expect(result.link.hidden).toBe(false)
    expect(navigate('#sandbox/pay/' + token).redirected).toBe('https://api.tabapay.ir/sandbox/pay/' + token)
  })

  it('does not follow invalid payment tokens or attacker-controlled external URLs', () => {
    for (const fragment of ['', '#https://evil.test/', '#pay/../../evil', '#pay/invalid']) {
      const result = navigate(fragment)
      expect(result.redirected).toBeNull()
      expect(result.link.hidden).toBe(true)
      expect(result.status.textContent).toContain('معتبر نیست')
    }
  })
})
