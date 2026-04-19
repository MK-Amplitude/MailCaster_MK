import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import {
  Menu,
  Mail,
  Users,
  FolderOpen,
  PenLine,
  Settings,
  LayoutDashboard,
  Ban,
  FileText,
  Paperclip,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: '대시보드', end: true },
  { to: '/contacts', icon: Users, label: '연락처' },
  { to: '/groups', icon: FolderOpen, label: '그룹' },
  { to: '/campaigns', icon: Mail, label: '메일 발송' },
  { to: '/templates', icon: FileText, label: '템플릿' },
  { to: '/signatures', icon: PenLine, label: '서명' },
  { to: '/attachments', icon: Paperclip, label: '첨부 파일' },
  { to: '/unsubscribes', icon: Ban, label: '수신거부' },
  { to: '/settings', icon: Settings, label: '설정' },
]

export function MobileSidebar() {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden h-8 w-8">
          <Menu className="w-5 h-5" />
        </Button>
      </SheetTrigger>
      {/* pt-safe: Sheet 이 열렸을 때 상단 로고/닫기 X 버튼이 iOS 상태바에
          가리지 않도록 safe-area-inset-top 만큼 위쪽 여백 확보. */}
      <SheetContent side="left" className="w-56 p-0 pt-safe">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b">
          <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
            <Mail className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-base">MailCaster</span>
        </div>
        <nav className="px-3 py-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  )
}
