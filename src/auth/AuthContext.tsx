import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { getCurrentUser, logoutSession, type AuthSession, type AuthUser } from '../lib/auth'
import { isApiConfigured } from '../lib/apiClient'

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  acceptSession: (session: AuthSession) => void
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!isApiConfigured()) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      setUser(await getCurrentUser())
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    acceptSession: (session) => setUser(session.user),
    refresh,
    logout: async () => { await logoutSession(); setUser(null) },
  }), [loading, refresh, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

export function ProtectedRoute() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="route-loader" role="status"><span /><p>در حال بررسی نشست امن…</p></div>
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
  return <Outlet />
}
