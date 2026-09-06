import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/apiClient'

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useApiQuery<T>(fetcher: () => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refetch = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetcher()
      .then((result) => {
        if (cancelled || !mounted.current) return
        setData(result)
      })
      .catch((fetchError: unknown) => {
        if (cancelled || !mounted.current) return
        const message =
          fetchError instanceof ApiError
            ? fetchError.message
            : fetchError instanceof Error
              ? fetchError.message
              : 'خطای ناشناخته رخ داد.'
        setError(message)
      })
      .finally(() => {
        if (cancelled || !mounted.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, loading, error, refetch }
}

interface MutationState<TPayload, TResult> {
  mutate: (payload: TPayload) => Promise<TResult | null>
  loading: boolean
  error: string | null
}

export function useApiMutation<TPayload, TResult>(
  mutator: (payload: TPayload) => Promise<TResult>,
  options?: { onSuccess?: (result: TResult) => void; onError?: (message: string) => void },
): MutationState<TPayload, TResult> {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutate = useCallback(
    async (payload: TPayload): Promise<TResult | null> => {
      setLoading(true)
      setError(null)
      try {
        const result = await mutator(payload)
        options?.onSuccess?.(result)
        return result
      } catch (mutationError: unknown) {
        const message =
          mutationError instanceof ApiError
            ? mutationError.message
            : mutationError instanceof Error
              ? mutationError.message
              : 'عملیات ناموفق بود.'
        setError(message)
        options?.onError?.(message)
        return null
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutator],
  )

  return { mutate, loading, error }
}
