import type { HTMLAttributes, ReactNode } from 'react'

interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode
  elevated?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

export function Card({ children, elevated = true, padding = 'md', className = '', ...props }: CardProps) {
  return (
    <section className={`card card--${padding} ${elevated ? 'card--elevated' : ''} ${className}`} {...props}>
      {children}
    </section>
  )
}

export function SectionHeading({
  title,
  action,
  icon,
}: {
  title: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="section-heading">
      <div className="section-heading__title">
        {icon}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  )
}
