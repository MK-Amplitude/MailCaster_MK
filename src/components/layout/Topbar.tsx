import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Moon, Sun, LogOut, Settings, Mail, PanelLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { OrgSwitcher } from './OrgSwitcher'
import { PendingInvitesBanner } from './PendingInvitesBanner'
import { useComposeLauncher } from '@/components/campaigns/ComposeLauncher'
import { useSidebar } from '@/contexts/SidebarContext'

export function Topbar() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const { openCompose } = useComposeLauncher()
  const { toggle } = useSidebar()
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )

  const toggleDark = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  const initials = (user?.user_metadata?.full_name as string)
    ?.split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? 'MC'

  return (
    <header className="h-14 border-b bg-card flex items-center justify-between px-4 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8">
          <PanelLeft className="w-4 h-4" />
        </Button>
        <OrgSwitcher />
        <PendingInvitesBanner />
      </div>
      <div className="flex items-center gap-2">
        {/* 글로벌 메일 작성 — 어느 페이지에서도 1:1 ad-hoc 발송 1 클릭 진입 */}
        <Button
          variant="default"
          size="sm"
          onClick={() => openCompose()}
          className="h-8 gap-1.5"
        >
          <Mail className="w-3.5 h-3.5" />
          메일 작성
        </Button>
        <Button variant="ghost" size="icon" onClick={toggleDark} className="h-8 w-8">
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.user_metadata?.avatar_url as string} />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <div className="px-3 py-2">
              <p className="text-sm font-medium truncate">
                {(user?.user_metadata?.full_name as string) ?? '사용자'}
              </p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <Settings className="w-4 h-4 mr-2" />
              설정
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={signOut}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="w-4 h-4 mr-2" />
              로그아웃
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
