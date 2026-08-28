import { CheckCircle2, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface ToastItem {
  id: number
  message: string
}

interface ToastContextValue {
  showToast: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id))
  }, [])

  const showToast = useCallback((message: string) => {
    const id = Date.now()
    setToasts((items) => [...items, { id, message }])
    window.setTimeout(() => dismiss(id), 3500)
  }, [dismiss])

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <CheckCircle2 size={20} />
            <span>{toast.message}</span>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="بستن پیام">
              <X size={17} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}
