import { Route, Routes } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { ChargeRequestsPage, InvoicesPage, WalletPage } from './pages/FinancePages'
import { ChangelogPage } from './pages/ChangelogPage'
import { DashboardPage } from './pages/DashboardPage'
import { DomainsPage, IpsPage, ServersPage, TrafficPackagesPage } from './pages/InfrastructurePages'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProfileGuardPage, ProfilePage, SessionsPage, SettingsPage } from './pages/AccountPages'
import { TicketsPage } from './pages/TicketsPage'
import { CreateServerPage, RegisterDomainPage } from './pages/WizardPages'
import { ProtectedRoute } from './auth/AuthContext'
import { AuthPage, GoogleCallbackPage } from './pages/AuthPages'
import { LandingPage } from './pages/LandingPage'
import { PlatformGate, PlatformPage } from './pages/PlatformPage'

export function App() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="login" element={<AuthPage intent="login" />} />
      <Route path="register" element={<AuthPage intent="register" />} />
      <Route path="forgot-password" element={<AuthPage intent="forgot" />} />
      <Route path="auth/callback" element={<GoogleCallbackPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="dashboard" element={<PlatformGate fallback={<DashboardPage />} />} />
          <Route path="platform" element={<PlatformPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="wallet" element={<PlatformGate fallback={<WalletPage />} />} />
          <Route path="invoices" element={<PlatformGate fallback={<InvoicesPage />} />} />
          <Route path="charge-requests" element={<PlatformGate fallback={<ChargeRequestsPage />} />} />
          <Route path="servers" element={<PlatformGate fallback={<ServersPage />} />} />
          <Route path="servers/create" element={<PlatformGate fallback={<CreateServerPage />} />} />
          <Route path="ips" element={<IpsPage />} />
          <Route path="traffic-packages" element={<TrafficPackagesPage />} />
          <Route path="domains" element={<DomainsPage />} />
          <Route path="domains/register" element={<RegisterDomainPage />} />
          <Route path="profile/update" element={<ProfilePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="guard-preview" element={<ProfileGuardPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
