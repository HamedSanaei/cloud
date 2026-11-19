import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MetricChart } from '../src/components/servers/MetricChart'
import type { ServerMetrics } from '../src/lib/serverManagement'
import { formatFaDateTime } from '../src/lib/format'

const time = Date.parse('2026-11-16T00:00:00Z') / 1000
const metrics = { start: new Date(time * 1000).toISOString(), end: new Date((time + 240) * 1000).toISOString(), step: 60 }
const series: ServerMetrics['series'] = { 'network.0.bandwidth.in': [[time, 0], [time + 60, 2500], [time + 120, null], [time + 180, 5000]], 'network.0.bandwidth.out': [[time, 200], [time + 60, 400], [time + 180, 800]] }
const open = (data = series, timezone = 'UTC') => render(<MetricChart title="Network (bytes/s)" unit="bytes/s" series={data} metrics={metrics} timezone={timezone} />)
describe('interpretable server monitoring charts', () => {
  it('shows timestamp and numeric axes, units, timezone and localized legends matching each plotted series', () => {
    open()
    const chart = screen.getByRole('img')
    expect(chart.getAttribute('aria-label')).toContain('به وقت UTC')
    expect(chart.querySelectorAll('text')).toHaveLength(6)
    expect(chart.textContent).toContain('۰۰:۰۰')
    expect(document.getElementById(chart.getAttribute('aria-describedby')!)?.textContent).toContain('bytes/s')
    const legend = screen.getByRole('list', { name: 'راهنمای سری‌های Network (bytes/s)' })
    expect(within(legend).getByText('ورودی شبکه — رابط 0')).toBeTruthy()
    expect(within(legend).getByText('خروجی شبکه — رابط 0')).toBeTruthy()
    const groups = chart.querySelectorAll('g[data-series]')
    const swatches = legend.querySelectorAll('line')
    expect(swatches).toHaveLength(groups.length)
    groups.forEach((group, index) => expect(group.getAttribute('stroke')).toBe(swatches[index].getAttribute('stroke')))
    expect(swatches[0].getAttribute('stroke')).not.toBe(swatches[1].getAttribute('stroke'))
  })

  it('keeps null and absent-interval gaps instead of drawing a connecting line or inventing zero', () => {
    open()
    const chart = screen.getByRole('img')
    expect(chart.querySelector('[data-series="network.0.bandwidth.in"]')?.querySelectorAll('path')).toHaveLength(2)
    expect(chart.querySelector('[data-series="network.0.bandwidth.out"]')?.querySelectorAll('path')).toHaveLength(2)
    const table = screen.getByRole('table', { hidden: true })
    const timestamps = [...table.querySelectorAll('time')]
    expect(timestamps.map(sample => sample.dateTime)).toEqual([0, 60, 120, 180].map(offset => new Date((time + offset) * 1000).toISOString()))
    expect(timestamps[0].textContent).toBe(formatFaDateTime(metrics.start, 'UTC'))
    const valuesAt = (sample: HTMLTimeElement) => [...sample.closest('tr')!.querySelectorAll('td')].map(cell => cell.textContent)
    expect(valuesAt(timestamps[0])).toEqual(['۰', '۲۰۰'])
    expect(valuesAt(timestamps[2])).toEqual(['داده موجود نیست', 'داده موجود نیست'])
  })

  it('uses the account timezone instead of stale saved preferences and labels disk read/write', () => {
    localStorage.setItem('cloud-timezone', 'UTC')
    open({ 'disk.0.bandwidth.read': [[time, 1]], 'disk.0.bandwidth.write': [[time, 2]] }, 'Asia/Tehran')
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('به وقت ایران')
    expect(screen.getByRole('img').textContent).toContain('۰۳:۳۰')
    const legend = within(screen.getByRole('list'))
    expect(legend.getByText('خواندن دیسک — 0')).toBeTruthy()
    expect(legend.getByText('نوشتن دیسک — 0')).toBeTruthy()
    localStorage.removeItem('cloud-timezone')
  })

  it('retains unavailable samples without a fabricated graph for all-null data', () => {
    open({ cpu: [[time, null], [time + 60, null]] })
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('داده در دسترس نیست — مقدار صفر فرض نمی‌شود.')).toBeTruthy()
    expect(within(screen.getByRole('table', { hidden: true })).getAllByText('داده موجود نیست')).toHaveLength(2)
  })
})
