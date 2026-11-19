import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { IntegrationNotice } from './IntegrationNotice'

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const location = useLocation()
  const closeSidebar = () => {
    setSidebarOpen(false)
    if (sidebarOpen) menuButton.current?.focus()
  }

  useEffect(() => {
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [location.pathname])

  return (
    <div className="app-shell">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="app-shell__main">
        <Topbar menuButton={menuButton} sidebarOpen={sidebarOpen} onOpenSidebar={() => setSidebarOpen(true)} />
        <main className="page-container">
          <IntegrationNotice key={location.pathname} />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
