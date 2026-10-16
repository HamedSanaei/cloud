import { describe, expect, it } from 'vitest'
import { maskEmail, maskMobile, normalizeIranMobile } from '../../src/modules/auth/delivery.js'
import { createRecoveryCodes, createTotpSecret, decryptTotpSecret, encryptTotpSecret, generateTotpCode, hashRecoveryCode, verifyTotp } from '../../src/modules/auth/totp.js'

describe('authentication helpers', () => {
  it('normalizes Iranian mobile numbers to E.164', () => {
    expect(normalizeIranMobile('0912 345 6789')).toBe('+989123456789')
    expect(normalizeIranMobile('989123456789')).toBe('+989123456789')
    expect(normalizeIranMobile('+98 (912) 345-6789')).toBe('+989123456789')
    expect(normalizeIranMobile('۰۹۱۲۳۴۵۶۷۸۹')).toBe('+989123456789')
    expect(normalizeIranMobile('08123456789')).toBeNull()
    expect(maskMobile('+989123456789')).toBe('09123***789')
  })

  it('masks email destinations', () => {
    expect(maskEmail('hamedsanaei@example.com')).toBe('ha*********@example.com')
  })

  it('generates, encrypts and verifies TOTP secrets', () => {
    const secret = createTotpSecret()
    const encrypted = encryptTotpSecret(secret)
    expect(encrypted).not.toContain(secret)
    expect(decryptTotpSecret(encrypted)).toBe(secret)
    const now = 1_790_000_000_000
    expect(verifyTotp(secret, generateTotpCode(secret, now), now)).toBe(true)
    expect(verifyTotp(secret, '000000', now)).toBe(false)
  })

  it('creates unique one-time recovery codes and stable hashes', () => {
    const codes = createRecoveryCodes()
    expect(codes).toHaveLength(8)
    expect(new Set(codes).size).toBe(8)
    expect(hashRecoveryCode(codes[0]!)).toBe(hashRecoveryCode(codes[0]!))
  })
})
