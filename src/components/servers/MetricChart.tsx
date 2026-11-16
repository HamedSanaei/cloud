import { useId } from 'react'
import { Card } from '../ui/Card'
import { displayTimeZone, formatFaDateTime, formatFaNumber } from '../../lib/format'
import type { ServerMetrics } from '../../lib/serverManagement'

const colors = ['var(--brand-500)', 'var(--success)', 'var(--danger-ink)', 'var(--ink)']
const dashes = ['', '8 4', '2 3', '10 3 2 3']
function seriesLabel(name: string) {
  if (name === 'cpu') return 'مصرف پردازنده'
  const network = name.match(/^network\.(.+)\.(?:bandwidth|pps)\.(in|out)$/)
  if (network) return `${network[2] === 'in' ? 'ورودی' : 'خروجی'} شبکه — رابط ${network[1]}`
  const disk = name.match(/^disk\.(.+)\.(?:bandwidth|iops)\.(read|write)$/)
  return disk ? `${disk[2] === 'read' ? 'خواندن' : 'نوشتن'} دیسک — ${disk[1]}` : name
}

export function MetricChart({ title, unit, series, metrics, timezone }: {
  title: string; unit: string; series: ServerMetrics['series']; metrics?: Pick<ServerMetrics, 'start' | 'end' | 'step'> | null; timezone?: string
}) {
  const descriptionId = useId(), zone = displayTimeZone(timezone)
  const entries = Object.entries(series).map(([name, values]) => ({ name, label: seriesLabel(name),
    values: values.filter(([time]) => Number.isFinite(time) && Number.isFinite(new Date(time * 1000).getTime()))
      .map(([time, value]) => [time, value !== null && Number.isFinite(value) ? value : null] as [number, number | null]).sort((a, b) => a[0] - b[0]),
  }))
  const points = entries.flatMap(entry => entry.values), valid = points.filter((point): point is [number, number] => point[1] !== null)
  const timestamps = points.map(point => point[0]), values = valid.map(point => point[1])
  const start = Date.parse(metrics?.start ?? '') / 1000, end = Date.parse(metrics?.end ?? '') / 1000
  const x0 = Math.min(...timestamps, ...(Number.isFinite(start) ? [start] : [])), x1 = Math.max(...timestamps, ...(Number.isFinite(end) ? [end] : []))
  const y0 = Math.min(0, ...values), y1 = Math.max(unit === '%' ? 100 : 1, ...values)
  const x = (time: number) => 96 + (time - x0) / (x1 - x0 || 1) * 478
  const y = (value: number) => 176 - (value - y0) / (y1 - y0 || 1) * 154
  const axisValue = new Intl.NumberFormat('fa-IR', { notation: 'compact', maximumFractionDigits: 2 })
  const exactValue = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 20 })
  const clock = new Intl.DateTimeFormat('fa-IR', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const date = (time: number) => formatFaDateTime(new Date(time * 1000).toISOString(), zone)
  const zoneLabel = zone === 'Asia/Tehran' ? 'به وقت ایران (Asia/Tehran)' : `به وقت ${zone}`
  return <Card className="server-chart"><h3>{title}</h3>
    <p className="server-chart-context" id={descriptionId}>محور زمان و جدول: {zoneLabel} · واحد مقدار: <bdi>{unit}</bdi>
      {points.length > 0 && <><br />از {date(x0)} تا {date(x1)}</>}</p>
    {valid.length === 0 ? <p>داده در دسترس نیست — مقدار صفر فرض نمی‌شود.</p> : <>
      <div className="server-chart-plot" role="region" aria-label={`ناحیهٔ نمودار ${title}`} tabIndex={0}><svg role="img" aria-label={`نمودار ${title}، ${formatFaNumber(valid.length)} نمونه واقعی، ${zoneLabel}؛ مقادیر دقیق در جدول نمونه‌ها`} aria-describedby={descriptionId} viewBox="0 0 600 230" style={{ direction: 'ltr' }}>
        {[y0, (y0 + y1) / 2, y1].map((value, i) => <g key={i}><line className="server-chart-gridline" x1="96" x2="574" y1={y(value)} y2={y(value)} /><text className="server-chart-axis" x="86" y={y(value) + 4} textAnchor="end">{axisValue.format(value)}</text></g>)}
        {(x0 === x1 ? [x0] : [x0, (x0 + x1) / 2, x1]).map((time, i) => <text className="server-chart-axis" key={i} x={x(time)} y="202" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{clock.format(time * 1000)}</text>)}
        {entries.map((entry, index) => {
          const paths: string[] = []; let current = '', previous: number | null = null
          entry.values.forEach(([time, value]) => {
            const gap = previous !== null && !!metrics?.step && time - previous > metrics.step * 1.5
            if (value === null || gap) { if (current) paths.push(current); current = '' }
            if (value !== null) current += `${current ? 'L' : 'M'}${x(time)},${y(value)} `
            previous = time
          })
          if (current) paths.push(current)
          return <g key={entry.name} data-series={entry.name} stroke={colors[index % colors.length]} strokeDasharray={dashes[Math.floor(index / colors.length) % dashes.length]} fill="none">
            {paths.map((path, i) => <path key={i} d={path} strokeWidth="2" />)}
            {entry.values.filter((point): point is [number, number] => point[1] !== null).map(([time, value], i) => <circle key={i} cx={x(time)} cy={y(value)} r="2" />)}
          </g>
        })}
      </svg></div>
      <p className="server-muted">کمینه: {exactValue.format(Math.min(...values))} · بیشینه: {exactValue.format(Math.max(...values))} <bdi>{unit}</bdi></p>
    </>}
    <ul className="server-chart-legend" aria-label={`راهنمای سری‌های ${title}`}>{entries.map((entry, index) => <li key={entry.name}>
      <svg aria-hidden="true" viewBox="0 0 32 12"><line x1="0" x2="32" y1="6" y2="6" stroke={colors[index % colors.length]} strokeWidth="3" strokeDasharray={dashes[Math.floor(index / colors.length) % dashes.length]} /></svg>
      <span>{entry.label}<small><bdi dir="ltr">{entry.name}</bdi></small></span>
    </li>)}</ul>
    {points.length > 0 && <details className="server-chart-samples"><summary>جدول زمان و مقدار نمونه‌ها ({formatFaNumber(points.length)})</summary>
      <div className="table-scroll" role="region" aria-label={`جدول نمونه‌های ${title}`} tabIndex={0}><table className="server-chart-table"><caption>{title} — {zoneLabel}</caption><thead><tr><th scope="col">زمان نمونه</th><th scope="col">سری</th><th scope="col">مقدار ({unit})</th></tr></thead>
        <tbody>{entries.flatMap(entry => entry.values.map(([time, value], index) => <tr key={`${entry.name}:${index}`}><td><time dateTime={new Date(time * 1000).toISOString()}>{date(time)}</time></td><td>{entry.label}</td><td>{value === null ? 'داده موجود نیست' : exactValue.format(value)}</td></tr>))}</tbody>
      </table></div></details>}
  </Card>
}
