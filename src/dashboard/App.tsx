import { Routes, Route } from 'react-router-dom'

import Layout from './layout/Layout'
import OverviewPage from './pages/OverviewPage'
import EndpointsPage from './pages/EndpointsPage'
import AddEndpointPage from './pages/AddEndpointPage'
import EndpointDetailPage from './pages/EndpointDetailPage'
import IncidentsPage from './pages/IncidentsPage'
import IncidentDetailPage from './pages/IncidentDetailPage'
import NotificationsPage from './pages/NotificationsPage'
import SettingsPage from './pages/SettingsPage'
import HealthPage from './pages/HealthPage'
import DocsPage from './pages/DocsPage'
import ChangelogPage from './pages/ChangelogPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/endpoints" element={<EndpointsPage />} />
        <Route path="/endpoints/add" element={<AddEndpointPage />} />
        <Route path="/endpoints/:id" element={<EndpointDetailPage />} />
        <Route path="/incidents" element={<IncidentsPage />} />
        <Route path="/incidents/:id" element={<IncidentDetailPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/changelog" element={<ChangelogPage />} />
      </Route>
    </Routes>
  )
}
