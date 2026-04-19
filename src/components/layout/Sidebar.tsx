import { NavLink } from 'react-router-dom'
import {
  Users,
  FolderOpen,
  PenLine,
  Mail,
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

export function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-56 border-r bg-card h-screen sticky top-0 shrink-0">
      {/* 로고 */}
      <div className="flex items-center gap-2.5 px-5 py-4 border-b">
        <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
          <Mail className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-base tracking-tight">MailCaster</span>
      </div>

      {/* 내비게이션 */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
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
    </aside>
  )
}
