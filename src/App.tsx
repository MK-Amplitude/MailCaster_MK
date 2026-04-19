import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/contexts/AuthContext'
import { ProtectedRoute } from '@/components/common/ProtectedRoute'
import { AppLayout } from '@/components/layout/AppLayout'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import ContactsPage from '@/pages/ContactsPage'
import GroupsPage from '@/pages/GroupsPage'
import SignaturesPage from '@/pages/SignaturesPage'
import TemplatesPage from '@/pages/TemplatesPage'
import CampaignsPage from '@/pages/CampaignsPage'
import CampaignWizardPage from '@/pages/CampaignWizardPage'
import CampaignDetailPage from '@/pages/CampaignDetailPage'
import AttachmentsPage from '@/pages/AttachmentsPage'
import UnsubscribesPage from '@/pages/UnsubscribesPage'
import SettingsPage from '@/pages/SettingsPage'
import NotFoundPage from '@/pages/NotFoundPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="contacts" element={<ContactsPage />} />
              <Route path="groups" element={<GroupsPage />} />
              <Route path="signatures" element={<SignaturesPage />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="campaigns" element={<CampaignsPage />} />
              <Route path="campaigns/new" element={<CampaignWizardPage />} />
              <Route path="campaigns/:id" element={<CampaignDetailPage />} />
              <Route path="attachments" element={<AttachmentsPage />} />
              <Route path="unsubscribes" element={<UnsubscribesPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="bottom-right" richColors />
      </AuthProvider>
    </QueryClientProvider>
  )
}
