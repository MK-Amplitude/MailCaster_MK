import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useCreateOrg } from '@/hooks/useOrganization'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Building2, Check, ChevronsUpDown, Plus, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 상단바의 조직 전환 드롭다운.
 * - 현재 조직 이름 + 내 역할 배지
 * - 참여 중인 조직 목록에서 선택 → 모든 리소스 쿼리 invalidate
 * - "새 조직 만들기" → 다이얼로그 → 생성 후 자동 전환
 * - "조직 설정" → /settings?tab=organization
 */
export function OrgSwitcher() {
  const { orgs, currentOrg, setCurrentOrg, orgsLoading } = useAuth()
  const navigate = useNavigate()
  const createOrg = useCreateOrg()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')

  const handleCreate = async () => {
    const name = newOrgName.trim()
    if (!name) return
    const org = await createOrg.mutateAsync(name)
    // 새 조직으로 자동 전환 — role 은 생성자 기준 'owner'
    setCurrentOrg({ ...org, role: 'owner' })
    setDialogOpen(false)
    setNewOrgName('')
  }

  const roleLabel = (role: string) =>
    role === 'owner' ? '오너' : role === 'admin' ? '관리자' : '멤버'

  const roleBadgeVariant = (role: string): 'default' | 'secondary' | 'outline' =>
    role === 'owner' ? 'default' : role === 'admin' ? 'secondary' : 'outline'

  if (orgsLoading && !currentOrg) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-2 max-w-[200px]">
        <Building2 className="w-4 h-4 shrink-0" />
        <span className="text-xs text-muted-foreground">불러오는 중...</span>
      </Button>
    )
  }

  if (!currentOrg) {
    // 조직이 전혀 없는 극히 예외적인 케이스 — trigger 가 실패한 경우 수동 생성
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          조직 만들기
        </Button>
        <CreateOrgDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          name={newOrgName}
          setName={setNewOrgName}
          onSubmit={handleCreate}
          isSubmitting={createOrg.isPending}
        />
      </>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2 max-w-[240px]">
            <Building2 className="w-4 h-4 shrink-0" />
            <span className="truncate text-sm">{currentOrg.name}</span>
            <Badge variant={roleBadgeVariant(currentOrg.role)} className="text-[10px] h-4 px-1.5 shrink-0">
              {roleLabel(currentOrg.role)}
            </Badge>
            <ChevronsUpDown className="w-3.5 h-3.5 opacity-50 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            조직 전환
          </DropdownMenuLabel>
          {orgs.map((org) => {
            const isCurrent = org.id === currentOrg.id
            return (
              <DropdownMenuItem
                key={org.id}
                onClick={() => {
                  if (!isCurrent) setCurrentOrg(org)
                }}
                className="gap-2"
              >
                <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{org.name}</p>
                  <p className="text-[10px] text-muted-foreground">{roleLabel(org.role)}</p>
                </div>
                <Check
                  className={cn('w-4 h-4 shrink-0', isCurrent ? 'opacity-100' : 'opacity-0')}
                />
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-2" />
            새 조직 만들기
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/settings?tab=organization')}>
            <SettingsIcon className="w-4 h-4 mr-2" />
            조직 설정
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrgDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        name={newOrgName}
        setName={setNewOrgName}
        onSubmit={handleCreate}
        isSubmitting={createOrg.isPending}
      />
    </>
  )
}

function CreateOrgDialog({
  open,
  onOpenChange,
  name,
  setName,
  onSubmit,
  isSubmitting,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  name: string
  setName: (v: string) => void
  onSubmit: () => void
  isSubmitting: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 조직 만들기</DialogTitle>
          <DialogDescription>
            팀/회사 이름을 입력하세요. 생성 후 멤버를 초대할 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="org-name">조직 이름</Label>
          <Input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: Amplitude 마케팅팀"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSubmit()
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={onSubmit} disabled={!name.trim() || isSubmitting}>
            {isSubmitting ? '생성 중...' : '생성'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
