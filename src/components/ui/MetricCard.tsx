import type { LucideIcon } from 'lucide-react'

export type Accent = 'blue' | 'green' | 'amber' | 'purple' | 'cyan' | 'red'

export function MetricCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  description,
}: {
  label: string
  value: string
  icon: LucideIcon
  accent?: Accent
  description?: string
}) {
  return (
    <article className="metric-card">
      <span className={`metric-card__icon accent--${accent}`}><Icon size={23} /></span>
      <strong>{value}</strong>
      <span>{label}</span>
      {description ? <small>{description}</small> : null}
    </article>
  )
}
