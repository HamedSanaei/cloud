import { expect, it } from 'vitest'
import { cumulativeTrafficBlocks, nextTrafficPeriod } from '../../src/modules/billing/hetzner-traffic.js'

const at = (date: string) => new Date(date)
const sample = { providerServerId: 'fixture:1', serverType: 'cx23', location: 'fsn1', outgoingBytes: 1_100_000_001,
  includedBytes: 1_000_000_000, observedAt: at('2026-11-30T23:00:00Z') }

it('rounds cumulative excess in decimal 100 MB blocks', () => {
  expect([0, 999_999_999, 1_000_000_000, 1_000_000_001, 1_100_000_000, 1_100_000_001]
    .map(outgoing => cumulativeTrafficBlocks(outgoing, 1_000_000_000))).toEqual([0, 0, 0, 1, 1, 2])
})

it('baselines legacy traffic, rejects regressions and requires reset evidence across the month', () => {
  const baseline = nextTrafficPeriod(undefined, sample, true)!
  expect(baseline).toMatchObject({ excludedBlocks: 2, paidBlocks: 0, month: '2026-11' })
  const saved = { ...baseline, id: 'row', serverId: 'server', subscriptionId: 'sub', settledAt: null }
  expect(nextTrafficPeriod(saved, sample, false)).toBeNull()
  expect(nextTrafficPeriod(saved, { ...sample, outgoingBytes: 0, observedAt: at('2026-11-30T23:59:00Z') }, false)).toBeNull()
  expect(nextTrafficPeriod(saved, { ...sample, observedAt: at('2026-12-01T00:01:00Z') }, false)).toBeNull()
  expect(nextTrafficPeriod(saved, { ...sample, outgoingBytes: 0, includedBytes: 2_000_000_000, observedAt: at('2026-12-01T01:00:00Z') }, false))
    .toMatchObject({ month: '2026-12', excludedBlocks: 0, paidBlocks: 0, includedBytes: 2_000_000_000 })
})
