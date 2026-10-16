import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { getConfig } from '../../config.js'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function encodeBase32(input: Uint8Array): string {
  let bits = ''
  for (const byte of input) bits += byte.toString(2).padStart(8, '0')
  let output = ''
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)]
  }
  return output
}

function decodeBase32(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=|\s/g, '')
  let bits = ''
  for (const char of normalized) {
    const value = BASE32.indexOf(char)
    if (value < 0) throw new Error('invalid base32')
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}

function encryptionKey(): Buffer {
  return scryptSync(getConfig().AUTH_SECRET, 'serverhub-auth-totp-v1', 32)
}

export function createTotpSecret(): string {
  return encodeBase32(randomBytes(20))
}

export function encryptTotpSecret(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptTotpSecret(value: string): string {
  const [iv, tag, encrypted] = value.split('.')
  if (!iv || !tag || !encrypted) throw new Error('invalid encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
}

function totpAt(secret: string, timestamp: number): string {
  const counter = Math.floor(timestamp / 30_000)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

export function generateTotpCode(secret: string, now = Date.now()): string {
  return totpAt(secret, now)
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false
  return [-30_000, 0, 30_000].some((offset) => {
    const expected = Buffer.from(totpAt(secret, now + offset))
    const supplied = Buffer.from(code)
    return expected.length === supplied.length && timingSafeEqual(expected, supplied)
  })
}

export function buildOtpAuthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`ServerHub:${email}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=ServerHub&algorithm=SHA1&digits=6&period=30`
}

export function createRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'))
}

export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', getConfig().AUTH_SECRET).update(`recovery:${code.replace(/\s/g, '').toUpperCase()}`).digest('hex')
}
