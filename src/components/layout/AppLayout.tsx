import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MobileSidebar } from './MobileSidebar'
import { Mail } from 'lucide-react'

export function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* 모바일 topbar */}
        <header className="h-14 border-b bg-card flex items-center justify-between px-4 sticky top-0 z-10 md:hidden">
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
        {/* 콘텐츠 */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
