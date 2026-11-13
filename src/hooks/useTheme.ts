import { useEffect, useState } from 'react'

/** Shared persisted appearance for both customer and admin shells. */
export function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('cloud-server-theme')
      if (saved === 'dark' || saved === 'light') return saved === 'dark'
      return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    } catch { return false }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try { localStorage.setItem('cloud-server-theme', dark ? 'dark' : 'light') } catch { /* Optional browser storage. */ }
  }, [dark])
  return [dark, setDark] as const
}
