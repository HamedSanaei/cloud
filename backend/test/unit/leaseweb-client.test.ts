import { afterEach, describe, expect, it, vi } from 'vitest'
import { LeasewebClient } from '../../src/modules/providers/leaseweb/client.js'
import { ProviderRetryableError } from '../../src/lib/errors.js'
import { pino } from 'pino'

const silentLogger = pino({ level: 'silent' })

function client() {
  return new LeasewebClient({ baseUrl: 'https://api.leaseweb.com', apiKey: 'test-key', logger: silentLogger, timeoutMs: 200 })
}

describe('LeasewebClient mutating POST classification', () => {
  afterEach(() => vi.restoreAllMocks())

  it('429 on a mutating POST is UNKNOWN, not retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"too many"}', { status: 429 }))
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind === 'unknown') expect(outcome.message).toContain('429')
  })

  it('5xx after order dispatch is UNKNOWN, not retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 503 }))
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind === 'unknown') expect(outcome.status).toBe(503)
  })

  it('HTTP 408 is ambiguous and never authorizes a replacement order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 408 }))
    expect((await client().postMutating('/publicCloud/v1/instances', {})).kind).toBe('unknown')
  })

  it('removes echoed credential fields and values before returning provider payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'safe', apiKey: 'test-key', nested: { authorization: 'test-key', note: 'echo test-key' },
    }), { status: 200 }))
    const payload = await client().get('/publicCloud/v1/regions')
    expect(JSON.stringify(payload)).not.toContain('test-key')
    expect(payload).toEqual({ id: 'safe', nested: { note: 'echo [REDACTED]' } })
  })

  it('network failure after transmission is UNKNOWN (may have been processed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind === 'unknown') expect(outcome.message).toContain('unknown')
  })

  it('timeout after transmission is UNKNOWN (may have been processed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind === 'unknown') expect(outcome.message).toContain('timed out')
  })

  it('validation 4xx is a definitive rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"invalid config"}', { status: 400 }))
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('definitive_rejection')
  })

  it('successful POST returns data and captures the provider correlation id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"orderId":"ord-1","state":"pending"}', { status: 201, headers: { 'APIGW-CORRELATION-ID': 'lsw-cor-123' } }),
    )
    const outcome = await client().postMutating('/ordering/v1/products/vps/VPS02_4/order', {})
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect((outcome.data as { orderId: string }).orderId).toBe('ord-1')
      expect(outcome.correlationId).toBe('lsw-cor-123')
    }
  })

  it('GET requests keep safe retry semantics (5xx -> retryable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 500 }))
    await expect(client().get('/vps/v1/virtualServers')).rejects.toBeInstanceOf(ProviderRetryableError)
  })

  it('captures APIGW-CORRELATION-ID on GET responses too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"virtualServers":[]}', { status: 200, headers: { 'APIGW-CORRELATION-ID': 'lsw-get-9' } }),
    )
    const { meta } = await client().getWithMeta('/vps/v1/virtualServers')
    expect(meta.providerCorrelationId).toBe('lsw-get-9')
  })
})