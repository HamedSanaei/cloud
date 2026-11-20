import { expect, it } from 'vitest'
import { decimalIranTariffs, embeddedPrices, formatTrafficTb, isPublicHomePrices, renderHomeTariffs, sortHetznerOffers, type TariffSort } from '../../src/contracts/home-tariffs.js'
import { safeReturnPath } from '../../src/contracts/return-path.js'

const plan = { id: 'fixture', name: '</script><img src=x onerror=alert(1)>', location: 'hel1', country: 'FI', city: 'Helsinki', vcpu: 2, memoryMb: 4096, diskGb: 40, diskType: 'Local', trafficGb: null, hourly: 123450, monthly: null }
const meta = { checkedAt: '2026-11-17T10:00:00Z', validUntil: '2026-11-17T10:01:00Z', catalogUpdatedAt: null, fxUpdatedAt: null, status: 'available' as const }
it('converts raw bytes and previously approved per-binary-unit tariffs for display', () => {
  expect(formatTrafficTb(1_000_000_000_000)).toBe('۱ TB')
  expect(formatTrafficTb(100_000_000)).toBe('۰٫۰۰۰۱ TB')
  expect(formatTrafficTb(1)).toBe('۰٫۰۰۰۰۰۰۰۰۰۰۰۱ TB')
  const legacy = { trafficUnit: 'TiB', tax: 'included', rates: { outbound: 123450, inbound: 0, cpu: 1000, ram: null } } as const
  expect(decimalIranTariffs(legacy)).toEqual({ ...legacy, trafficUnit: 'TB', rates: { ...legacy.rates, outbound: 112277 } })
  expect(renderHomeTariffs(legacy, null)).not.toContain('TiB')
  expect(legacy.rates.outbound).toBe(123450)
})
it('includes all prices in SSR and keeps the extra TB rate indicative', () => {
  const priced = { ...plan, monthly: 6789000, trafficOverage: { perTbRial: 333450, includedBytes: 2 ** 39,
    source: 'hetzner-server-type-location' as const, observedAt: meta.checkedAt, fxAt: meta.checkedAt, ruleVersion: meta.checkedAt } }
  const html = renderHomeTariffs(null, [priced], meta, 'hetzner', 'monthly')
  expect(html).toContain('۱۲٬۳۴۵ تومان')
  expect(html).toContain('۶۷۸٬۹۰۰ تومان')
  expect(html).toContain('۳۳٬۳۴۵ تومان')
  expect(html).toContain('۰٫۵۴۹۷۵۵۸۱۳۸۸۸ TB')
  expect(html).toContain('period=monthly&amp;location=hel1')
  expect(renderHomeTariffs(null, [priced], meta, 'hetzner', 'hourly')).toContain('period=hourly&amp;location=hel1')
  expect(html).toContain('هزینهٔ مازاد ساعتی محاسبه می‌شود')
  expect(html).not.toContain('استعلامی')
  expect(html).not.toContain('انتخاب ماهانه')
  expect(html).toContain('<td><bdi>۶۷۸٬۹۰۰ تومان</bdi></td>')
  expect(embeddedPrices(html)?.hetzner).toEqual([priced])
  expect(isPublicHomePrices({ iran: null, hetzner: [{ ...priced, trafficOverage: { ...priced.trafficOverage, perTbRial: 0 } }], meta })).toBe(false)
})
it('shows the verified byte allowance independently of a missing overage price', () => {
  const offer = { ...plan, trafficGb: 21_990, includedTrafficBytes: 20 * 2 ** 40, trafficOverage: null }
  const html = renderHomeTariffs(null, [offer], meta)
  expect(html).toContain('۲۱٫۹۹۰۲۳۲۵۵۵۵۲ TB')
  expect(html).not.toContain('۲۱٬۹۹۰')
  expect(html).toContain('نرخ معتبر در دسترس نیست')
  expect(embeddedPrices(html)?.hetzner).toEqual([offer])
})
it('escapes provider text and safely roundtrips the SSR snapshot without executing markup', () => {
  const html = renderHomeTariffs(null, [plan], meta, 'hetzner')
  expect(html.match(/<img\b[^>]*>/g)).toEqual([expect.stringMatching(/^<img src="\/flags\/fi\.svg"[^>]*>$/)])
  expect(html).toContain('&lt;/script&gt;')
  expect(embeddedPrices(html)).toEqual({ iran: null, hetzner: [plan], meta })
  expect(html).toContain('۱۲٬۳۴۵ تومان')
  expect(html).toContain('قیمت ماهانهٔ معتبر در دسترس نیست')
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

it('sorts names naturally and numeric specifications in both directions with unknown prices and quotas last', () => {
  const offers = [
    { ...plan, id: 'large', name: 'CX10', country: 'FI', vcpu: 8, memoryMb: 10240, diskGb: 100, includedTrafficBytes: 20 * 2 ** 40, monthly: 100 },
    { ...plan, id: 'small', name: 'CX2', country: 'DE', vcpu: 1, memoryMb: 1024, diskGb: 20, includedTrafficBytes: 2 ** 40, monthly: 20 },
    { ...plan, id: 'unknown', name: 'CX3', country: 'ES' },
  ]
  const sort = (by: TariffSort['by'], direction: TariffSort['direction']) => sortHetznerOffers(offers, { by, direction, period: 'monthly' }).map(o => o.id)
  for (const by of ['name', 'location', 'vcpu', 'memoryMb', 'diskGb'] as const) {
    expect(sort(by, 'asc')).toEqual(['small', 'unknown', 'large'])
    expect(sort(by, 'desc')).toEqual(['large', 'unknown', 'small'])
  }
  for (const by of ['price', 'traffic'] as const) {
    expect(sort(by, 'asc')).toEqual(['small', 'large', 'unknown'])
    expect(sort(by, 'desc')).toEqual(['large', 'small', 'unknown'])
  }
})
