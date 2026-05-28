import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileSidebar } from './MobileSidebar'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { ComposeLauncherProvider } from '@/components/campaigns/ComposeLauncher'
import { Mail } from 'lucide-react'

export function AppLayout() {
  // ComposeLauncherProvider — 전역 "+ 메일 작성" launcher 를 모든 페이지가 useComposeLauncher() 로 사용.
  // ProtectedRoute 내부라 인증된 사용자만 활성화.
  return (
    <ComposeLauncherProvider>
      <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* 모바일 topbar
           - iOS 에서 viewport-fit=cover + status-bar-style=black-translucent 때문에
             앱 화면이 상태바(노치/Dynamic Island) 뒤까지 확장된다. 그냥 h-14 로 두면
             햄버거 버튼이 상태바 시계에 가려 탭 불가.
           - height = 56px + safe-area-inset-top, padding-top = safe-area-inset-top
             → 실제 콘텐츠 영역은 여전히 56px 로 flex-center 가 제대로 정렬됨. */}
        <header className="h-[calc(3.5rem+env(safe-area-inset-top))] pt-safe border-b bg-card flex items-center justify-between px-4 sticky top-0 z-10 md:hidden">
          <div className="flex items-center gap-2">
            <MobileSidebar />
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-primary rounded flex items-center justify-center">
                <Mail className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="font-bold text-sm">MailCaster</span>
            </div>
          </div>
        </header>
        {/* 데스크톱 topbar */}
        <div className="hidden md:block">
          <Topbar />
        </div>
        {/* 콘텐츠 — 페이지별 ErrorBoundary 로 감싸 한 페이지 에러가 전체
            앱을 깨지 않게 한다. 사이드바/탑바는 살아 있어 다른 페이지 이동 가능. */}
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      </div>
    </ComposeLauncherProvider>
  )
}
