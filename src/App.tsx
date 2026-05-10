import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/contexts/AuthContext'
import { ProtectedRoute } from '@/components/common/ProtectedRoute'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { AppLayout } from '@/components/layout/AppLayout'
import LoginPage from '@/pages/LoginPage'
import ContactsPage from '@/pages/ContactsPage'
import GroupsPage from '@/pages/GroupsPage'
import EngagementPage from '@/pages/EngagementPage'
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
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/*
          basename = Vite 의 `base` 값과 동일하게 유지해야 한다.
          import.meta.env.BASE_URL 은 Vite 가 자동 주입:
            - `npm run dev`  → `/`
            - `npm run build`(GH Pages 용) → `/MailCaster_MK/`
          이 prop 이 없으면 GH Pages 경로(`/MailCaster_MK/`) 에서 앱이 열릴 때
          Router 가 그 prefix 를 라우트로 해석해 NotFoundPage 로 빠진다.
        */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              {/* "/" 가 곧 관계 관리 대시보드. /engagement 는 옛 북마크용 redirect. */}
              <Route index element={<EngagementPage />} />
              <Route path="engagement" element={<Navigate to="/" replace />} />
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
    </ErrorBoundary>
  )
}
