import { describe, expect, it } from 'vitest'
import { PARSGREEN_AUTH_SAMPLES, PARSGREEN_TEMPLATES, SMS_CATALOG, smsKeys, renderSms, smsSegments } from '../../src/modules/auth/parsgreen-templates.js'

describe('owner-confirmed dynamic patterns (2026-11-16)', () => {
  it('keeps 20 business and four auth switches with explicit approved dynamic patterns', () => {
    expect(Object.keys(PARSGREEN_TEMPLATES)).toHaveLength(20)
    expect(Object.keys(PARSGREEN_AUTH_SAMPLES)).toHaveLength(4)
    expect(new Set(smsKeys).size).toBe(24)
    for (const template of Object.values(SMS_CATALOG)) {
      expect(template.approval).toBe('approved-pattern')
      expect((template.pattern.match(/%%/g) ?? []).length).toBe(template.variables.length)
      expect(template.sample).not.toContain('%%')
    }
  })
  it.each(smsKeys)('renders %s in registered placeholder order', key => {
    const template = SMS_CATALOG[key]
    const values = Object.fromEntries(template.variables.map((key, i) => [key, key === 'code' ? '479125' : `value${i}`]))
    const rendered = renderSms(key, values)
    let i = 0
    expect(rendered).toBe(template.pattern.replaceAll('%%', () => values[template.variables[i++]!]!))
    expect(rendered.startsWith('پارس سرور')).toBe(true)
    expect(smsSegments(rendered).segments).toBeGreaterThan(0)
  })
  it.each([[0, 0], [70, 1], [71, 2], [134, 2], [135, 3]])('counts UTF-16 length %i as %i segments', (length, segments) => {
    expect(smsSegments('ش'.repeat(length))).toEqual({ units: length, segments })
  })
  it('counts surrogate pairs, ZWNJ and newlines, without truncating security content', () => {
    expect(smsSegments('😀')).toEqual({ units: 2, segments: 1 })
    expect(smsSegments('می‌شود\n')).toEqual({ units: 7, segments: 1 })
    const long = renderSms('serverActivated', { serviceName: 'server-'.repeat(9), serverIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' })
    expect(long).toContain('2001:0db8:85a3:0000:0000:8a2e:0370:7334')
    expect(smsSegments(long).segments).toBeGreaterThan(1)
    expect(() => renderSms('ticketCreated', {})).toThrow()
    expect(() => renderSms('newLogin', { ip: 'injected\n@elsewhere.test #123456' })).toThrow()
  })
  it('keeps compact domain-bound OTP at exactly 56 units / one segment', () => {
    const message = renderSms('phoneLogin', { code: '479125' })
    expect(message).toBe('پارس سرور: کد ورود 479125؛ محرمانه\n@parserver.ir #479125')
    expect(smsSegments(message)).toEqual({ units: 56, segments: 1 })
    expect(message.endsWith('@parserver.ir #479125')).toBe(true)
  })
})
