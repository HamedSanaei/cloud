import { expect, it } from 'vitest'
import { embeddedPrices, isPublicHomePrices, renderHomeTariffs, sortHetznerOffers } from '../../src/contracts/home-tariffs.js'
import { safeReturnPath } from '../../src/contracts/return-path.js'

const plan = { id: 'fixture', name: '</script><img src=x onerror=alert(1)>', location: 'hel1', country: 'FI', city: 'Helsinki', vcpu: 2, memoryMb: 4096, diskGb: 40, diskType: 'Local', trafficGb: null, hourly: 123450, monthly: null }
const meta = { checkedAt: '2026-11-17T10:00:00Z', validUntil: '2026-11-17T10:01:00Z', catalogUpdatedAt: null, fxUpdatedAt: null, status: 'available' as const }
it('escapes provider text and safely roundtrips the SSR snapshot without executing markup', () => {
  const html = renderHomeTariffs(null, [plan], meta, 'hetzner')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;/script&gt;')
  expect(embeddedPrices(html)).toEqual({ iran: null, hetzner: [plan], meta })
  expect(html).toContain('۱۲٬۳۴۵ تومان')
  expect(html).toContain('عرضه نمی‌شود') // Never derive monthly by multiplying hourly.
  expect(html).not.toContain('tariff-scroll" tabindex="0" role="region" aria-label="نرخ واحد منابع سرور ایران')
})
it('rejects malformed public payloads, including optional display fields, without coercing prices', () => {
  expect(isPublicHomePrices({ iran: null, hetzner: [plan], meta })).toBe(true)
  for (const invalid of [{ hourly: '123450' }, { monthly: -1 }, { country: {} }, { diskType: {} }, { trafficGb: -1 }]) {
    expect(isPublicHomePrices({ iran: null, hetzner: [{ ...plan, ...invalid }], meta })).toBe(false)
  }
  expect(isPublicHomePrices({ iran: null, hetzner: [], meta: { ...meta, validUntil: 'invalid' } })).toBe(false)
})
it('sorts independent native periods without mutating the authoritative offer list', () => {
  const offers = [{ ...plan, id: 'a', hourly: 20, monthly: 10 }, { ...plan, id: 'b', hourly: 10, monthly: 20 }, { ...plan, id: 'c', hourly: null, monthly: null }]
  expect(sortHetznerOffers(offers, 'hourly').map(o => o.id)).toEqual(['b', 'a', 'c'])
  expect(sortHetznerOffers(offers, 'monthly').map(o => o.id)).toEqual(['a', 'b', 'c'])
  expect(offers.map(o => o.id)).toEqual(['a', 'b', 'c'])
})
it('retains local purchase intent but rejects external and header-injection redirect targets', () => {
  const path = '/servers/create?offer=real-plan&period=monthly&location=hel1'
  expect(safeReturnPath(path)).toBe(path)
  for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', '/%5cevil.example', '/x%0d%0aLocation:evil', undefined, ' '.repeat(3001)]) expect(safeReturnPath(value)).toBe('/dashboard')
})
