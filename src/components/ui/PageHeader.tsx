import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        <div className="page-header__title-row">
          {icon ? <span className="page-header__icon">{icon}</span> : null}
          <h1>{title}</h1>
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  )
}
