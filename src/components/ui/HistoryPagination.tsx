import { formatCount } from '../../lib/format'
import { Button } from './Button'

export function HistoryPagination({ label, page, canGoBack, hasMore, previous, next }: {
  label: string
  page: number
  canGoBack: boolean
  hasMore: boolean
  previous: () => void
  next: () => void
}) {
  if (!canGoBack && !hasMore) return null
  return <div className="segmented-filter" aria-label={label} role="group">
    <Button variant="secondary" size="sm" disabled={!canGoBack} onClick={previous}>صفحهٔ قبل</Button>
    <span aria-live="polite">صفحهٔ {formatCount(page)}</span>
    <Button variant="secondary" size="sm" disabled={!hasMore} onClick={next}>صفحهٔ بعد</Button>
  </div>
}
