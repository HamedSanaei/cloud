import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { toast, ToastContainer, type TypeOptions } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

interface ToastContextValue {
  showToast: (message: string, type?: TypeOptions, id?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const showToast = useCallback((message: string, type: TypeOptions = 'info', id?: string) => {
    const emit = type === 'success' ? toast.success : type === 'error' ? toast.error : type === 'warning' ? toast.warn : toast.info
    emit(message, { toastId: id, role: type === 'error' ? 'alert' : 'status' })
  }, [])

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer rtl position="top-center" autoClose={5000} limit={4} pauseOnFocusLoss closeOnClick={false} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}
