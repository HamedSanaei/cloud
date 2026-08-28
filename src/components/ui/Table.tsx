import type { ReactNode } from 'react'

export function Table({ headers, children }: { headers: string[]; children?: ReactNode }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}
