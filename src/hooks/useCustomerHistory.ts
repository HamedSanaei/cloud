import { useState } from 'react'
import { normalizeSearchText } from '../../backend/src/contracts/search-text'
import { useApiQuery } from './useApiQuery'
import { useDebouncedValue } from './useDebouncedValue'

export interface HistoryFilters {
  search: string
  status: string
  offset: number
  department?: string
}

export interface HistoryPage<T> {
  items: T[]
  pagination?: { offset: number; nextOffset: number | null }
}

export function useCustomerHistory<T extends HistoryPage<unknown>>(
  load: (filters: HistoryFilters) => Promise<T>,
  filters: Omit<HistoryFilters, 'offset'>,
  scope: string,
) {
  const [offsets, setOffsets] = useState([0])
  const [supportsPagination, setSupportsPagination] = useState<boolean>()
  const offset = offsets[offsets.length - 1]
  const search = normalizeSearchText(filters.search).slice(0, 200)
  const settledSearch = useDebouncedValue(search)
  const remote = supportsPagination !== false
  const requestSearch = remote ? settledSearch : ''
  const requestStatus = remote ? filters.status : 'all'
  const requestDepartment = remote && filters.department !== 'all' ? filters.department : undefined
  const query = useApiQuery(async () => {
    const result = await load({ search: requestSearch, status: requestStatus, department: requestDepartment, offset })
    setSupportsPagination(!!result.pagination)
    return result
  }, [scope, requestSearch, requestStatus, requestDepartment, offset])
  const nextOffset = query.data?.pagination?.nextOffset
  return {
    ...query, search, loading: query.loading || (remote && search !== settledSearch),
    page: offsets.length,
    canGoBack: offset > 0,
    hasMore: nextOffset != null,
    resetPage: () => setOffsets([0]),
    previous: () => setOffsets(pages => pages.length > 1 ? pages.slice(0, -1) : pages),
    next: () => { if (nextOffset != null) setOffsets(pages => [...pages, nextOffset]) },
  }
}
