import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './FormControls'

export function FilterPanel({
  query,
  onQueryChange,
  placeholder = 'جستجو...',
  children,
  onReset,
}: {
  query: string
  onQueryChange: (value: string) => void
  placeholder?: string
  children?: ReactNode
  onReset?: () => void
}) {
  return (
    <Card className="filter-panel" padding="sm">
      <Input
        search
        aria-label="جستجو"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={placeholder}
      />
      <div className="filter-panel__controls">
        {children}
        {onReset ? (
          <Button variant="ghost" size="sm" icon={<RotateCcw size={16} />} onClick={onReset}>
            پاک کردن فیلترها
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
