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

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
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
        <Route path="changelog" element={<ChangelogPage />} />
        <Route path="guard-preview" element={<ProfileGuardPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
