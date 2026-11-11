import { Navigate, Route, Routes } from 'react-router-dom'
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
import { TelegramSettingsPage } from './pages/TelegramSettingsPage'
import { PlatformAdminPage } from './pages/PlatformAdminPage'
import { AdminLayout } from './admin/AdminLayout'
import { AdminOverview, AdminOrders, AdminOrderPage, AdminUsers, AdminUserPage, AdminUserServers, AdminServers, AdminServerPage } from './admin/AdminPages'

export function App() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="login" element={<AuthPage intent="login" />} />
      <Route path="register" element={<AuthPage intent="register" />} />
      <Route path="forgot-password" element={<AuthPage intent="forgot" />} />
      <Route path="auth/callback" element={<GoogleCallbackPage />} />
      <Route path="admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="orders/:id" element={<AdminOrderPage />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="users/:id" element={<AdminUserPage />} />
        <Route path="users/:id/servers" element={<AdminUserServers />} />
        <Route path="servers" element={<AdminServers />} />
        <Route path="servers/:id" element={<AdminServerPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="platform" element={<Navigate to="/settings/telegram" replace />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="wallet" element={<WalletPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="charge-requests" element={<ChargeRequestsPage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="servers/create" element={<CreateServerPage />} />
          <Route path="ips" element={<IpsPage />} />
          <Route path="traffic-packages" element={<TrafficPackagesPage />} />
          <Route path="domains" element={<DomainsPage />} />
          <Route path="domains/register" element={<RegisterDomainPage />} />
          <Route path="profile/update" element={<ProfilePage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/telegram" element={<TelegramSettingsPage />} />
          <Route path="settings/platform-admin" element={<PlatformAdminPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="guard-preview" element={<ProfileGuardPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
