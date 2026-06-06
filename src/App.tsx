import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { Loader2 } from 'lucide-react'
import { AuthProvider } from '@/contexts/AuthContext'
import { ProtectedRoute } from '@/components/common/ProtectedRoute'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { AppLayout } from '@/components/layout/AppLayout'

// 첫 화면 / 자주 들어가는 페이지는 eager — 라우터 초기 로드에 포함.
import LoginPage from '@/pages/LoginPage'
import EngagementPage from '@/pages/EngagementPage'  // "/" 대시보드
import ContactsPage from '@/pages/ContactsPage'
import GroupsPage from '@/pages/GroupsPage'
import NotFoundPage from '@/pages/NotFoundPage'

// 무거운 / 가끔 들어가는 페이지는 lazy — 첫 페이지 로드 번들에서 제외.
//   - CampaignWizardPage / CampaignDetailPage: 발송 흐름 (TipTap, 큰 폼)
//   - TemplatesPage / SignaturesPage: TipTap 의존
//   - AttachmentsPage: 파서/스토리지 의존
//   - SettingsPage / UnsubscribesPage: 자주 쓰지 않음
const InboxPage = lazy(() => import('@/pages/InboxPage'))
const ContactPage = lazy(() => import('@/pages/ContactPage'))
const SignaturesPage = lazy(() => import('@/pages/SignaturesPage'))
const TemplatesPage = lazy(() => import('@/pages/TemplatesPage'))
const CampaignsPage = lazy(() => import('@/pages/CampaignsPage'))
const SequencesPage = lazy(() => import('@/pages/SequencesPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))
const CampaignWizardPage = lazy(() => import('@/pages/CampaignWizardPage'))
const CampaignDetailPage = lazy(() => import('@/pages/CampaignDetailPage'))
const AttachmentsPage = lazy(() => import('@/pages/AttachmentsPage'))
const UnsubscribesPage = lazy(() => import('@/pages/UnsubscribesPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))

// React Query 기본값.
//   - refetchOnWindowFocus: false
//     기본 true 면 사용자가 다른 탭 갔다 돌아올 때마다 stale 쿼리 일제 refetch.
//     이 앱은 모든 mutation 후 invalidateQueries(98곳) 로 캐시 무효화 처리하고 있어
//     focus 시 자동 refetch 가 사실상 중복 작업. 트래픽/지연 절감 위해 끔.
//     (실시간성 필요한 곳은 refetchInterval 로 명시 — 예: useRecipients 발송 중 폴링)
//   - staleTime: 5분
//     대부분 데이터(연락처/그룹/캠페인 목록)는 분 단위로 안 바뀜.
//     동일 페이지 재방문 시 즉시 캐시 반환 → 체감 속도 향상.
//   - retry: 1
//     네트워크 일시 오류는 한 번만 재시도. 진짜 에러는 빨리 사용자에게 표시.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// 라우트 단위 lazy 로딩의 fallback — 페이지 청크가 다운로드되는 사이 보일 화면.
function PageFallback() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  )
}

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
            <Suspense fallback={<PageFallback />}>
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
                  <Route path="inbox" element={<InboxPage />} />
                  <Route path="contacts" element={<ContactsPage />} />
                  <Route path="contacts/:id" element={<ContactPage />} />
                  <Route path="groups" element={<GroupsPage />} />
                  <Route path="signatures" element={<SignaturesPage />} />
                  <Route path="templates" element={<TemplatesPage />} />
                  <Route path="campaigns" element={<CampaignsPage />} />
                  <Route path="sequences" element={<SequencesPage />} />
                  <Route path="analytics" element={<AnalyticsPage />} />
                  <Route path="campaigns/new" element={<CampaignWizardPage />} />
                  <Route path="campaigns/:id" element={<CampaignDetailPage />} />
                  <Route path="attachments" element={<AttachmentsPage />} />
                  <Route path="unsubscribes" element={<UnsubscribesPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster position="bottom-right" richColors />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
