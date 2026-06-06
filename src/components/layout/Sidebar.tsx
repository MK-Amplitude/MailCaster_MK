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
  Inbox,
  Workflow,
  BarChart3,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// IA 재배치: 고빈도 행위 (대시보드/받은편지함/연락처/메일 발송) 가 상단,
//            저빈도 자산 (템플릿/서명/첨부/수신거부/그룹/설정) 이 하단.
const primaryNav = [
  { to: '/', icon: LayoutDashboard, label: '대시보드', end: true },
  { to: '/inbox', icon: Inbox, label: '받은편지함' },
  { to: '/contacts', icon: Users, label: '연락처' },
  { to: '/campaigns', icon: Mail, label: '메일 발송' },
  { to: '/sequences', icon: Workflow, label: '시퀀스' },
  { to: '/templates', icon: FileText, label: '템플릿' },
]
const secondaryNav = [
  { to: '/analytics', icon: BarChart3, label: '분석' },
  { to: '/groups', icon: FolderOpen, label: '그룹' },
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

      {/* 내비게이션 — 고빈도 행위가 상단, 자산/설정이 하단 (구분선) */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {primaryNav.map(({ to, icon: Icon, label, end }) => (
          <NavItem key={to} to={to} icon={Icon} label={label} end={end} />
        ))}
        <div className="border-t my-3 mx-1" />
        {secondaryNav.map(({ to, icon: Icon, label }) => (
          <NavItem key={to} to={to} icon={Icon} label={label} />
        ))}
      </nav>
    </aside>
  )
}

function NavItem({
  to,
  icon: Icon,
  label,
  end,
}: {
  to: string
  icon: typeof Mail
  label: string
  end?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        )
      }
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
    </NavLink>
  )
}
