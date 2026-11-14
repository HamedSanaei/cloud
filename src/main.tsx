import '@fontsource/vazirmatn/400.css'
import '@fontsource/vazirmatn/500.css'
import '@fontsource/vazirmatn/600.css'
import '@fontsource/vazirmatn/700.css'
import '@fontsource/vazirmatn/800.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { ToastProvider } from './components/ui/Toast'
import { AuthProvider } from './auth/AuthContext'
import './styles.css'
import './penpot.css'
import './public.css'
import './auth-layout.css'
import './panel-layout.css'
import './dropdown.css'
import './server-management.css'

const root = document.getElementById('root')!
const initialTariffs = window.location.pathname === '/' ? document.getElementById('home-tariff-content')?.innerHTML : undefined
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App initialTariffs={initialTariffs?.includes('<!--#') ? undefined : initialTariffs} />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
