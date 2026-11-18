import { expect, it } from 'vitest'
import { indicativeHetznerTraffic } from '../../src/modules/pricing/hetzner-traffic.js'

const observed = new Date('2026-11-18T08:00:00Z')
const evidence = { source: 'hetzner-server-type-location', location: 'fsn1', currency: 'EUR', grossPerTb: '1.125', includedTrafficBytes: 20e12 }
const product = { provider: 'hetzner', providerCurrency: 'EUR', raw: { trafficTariff: evidence }, lastSyncedAt: observed }
const rule = { markupPercent: '25', markupFixedRial: 999_999, taxPercent: '10', roundingToRial: 1000, updatedAt: observed, enabled: true }
const fx = { rate: '620000', createdAt: observed }

it('prices decimal TB using FX, percentage markup and tax at the exact IRR boundary', () => {
  expect(indicativeHetznerTraffic(product, 'fsn1', rule, fx)).toEqual({
    perTbRial: 959062, includedBytes: 20e12, source: evidence.source, observedAt: observed.toISOString(),
    ruleVersion: observed.toISOString(), fxAt: observed.toISOString(),
  })
})

it('never replaces absent or inconsistent source evidence with a zero or another region’s rate', () => {
  expect(indicativeHetznerTraffic(product, 'ash', rule, fx)).toBeNull()
  expect(indicativeHetznerTraffic({ ...product, providerCurrency: 'USD' }, 'fsn1', rule, fx)).toBeNull()
  expect(indicativeHetznerTraffic({ ...product, raw: null }, 'fsn1', rule, fx)).toBeNull()
  expect(indicativeHetznerTraffic({ ...product, raw: { trafficTariff: { ...evidence, grossPerTb: '0' } } }, 'fsn1', rule, fx)).toBeNull()
})
