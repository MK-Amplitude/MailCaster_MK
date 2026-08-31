import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileSidebar } from './MobileSidebar'
import { OrgSwitcher } from './OrgSwitcher'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { ComposeLauncherProvider } from '@/components/campaigns/ComposeLauncher'
import { SidebarProvider, useSidebar } from '@/contexts/SidebarContext'
import { cn } from '@/lib/utils'
import { Mail } from 'lucide-react'

export function AppLayout() {
  return (
    <SidebarProvider>
      <ComposeLauncherProvider>
        <AppLayoutInner />
      </ComposeLauncherProvider>
    </SidebarProvider>
  )
}

function AppLayoutInner() {
  const { open } = useSidebar()
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar — width animated via CSS transition */}
      <div
        className={cn(
          'hidden md:block shrink-0 overflow-hidden transition-all duration-300',
          open ? 'w-56' : 'w-0',
        )}
      >
        <Sidebar />
      </div>
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Mobile topbar — 로고 대신 조직 전환기 노출 (브랜딩은 사이드시트 헤더에 있음).
            조직 선택은 기기별 localStorage 라 새 기기에선 기본값(가장 먼저 가입한
            조직 = 빈 개인 워크스페이스)이 잡힐 수 있어, 모바일에서도 어떤 조직을
            보고 있는지 표시하고 전환할 수 있어야 한다. */}
        <header className="h-[calc(3.5rem+env(safe-area-inset-top))] pt-safe border-b bg-card flex items-center justify-between px-4 sticky top-0 z-10 md:hidden">
          <div className="flex items-center gap-2 min-w-0">
            <MobileSidebar />
            <div className="w-6 h-6 bg-primary rounded flex items-center justify-center shrink-0">
              <Mail className="w-3.5 h-3.5 text-white" />
            </div>
            <OrgSwitcher />
          </div>
        </header>
        {/* Desktop topbar */}
        <div className="hidden md:block">
          <Topbar />
        </div>
        <main className="flex-1 overflow-y-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
