import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileSidebar } from './MobileSidebar'
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
        {/* Mobile topbar */}
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
