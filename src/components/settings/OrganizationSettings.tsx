// ============================================================
// OrganizationSettings — 현재 조직의 정보/멤버/초대 관리
// ------------------------------------------------------------
// 권한 규칙:
//   - 조직 정보 수정 / 멤버 제거 / 역할 변경 / 초대: admin+
//   - 조직 삭제: owner 만
//   - 본인 탈퇴: 모든 역할 (단, 마지막 owner 탈퇴는 RLS 로 막지 않음 — UI 에서 경고)
// 정책 기반: 015 RLS — organizations/org_members/org_invitations 각각 split policy
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import {
  useOrgMembers,
  useOrgInvitations,
  useUpdateOrg,
  useDeleteOrg,
  useInviteMember,
  useCancelInvitation,
  useRemoveMember,
  useUpdateMemberRole,
} from '@/hooks/useOrganization'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  Building2,
  UserPlus,
  MoreHorizontal,
  Save,
  Trash2,
  Mail,
  XCircle,
  LogOut,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, isValidEmail } from '@/lib/utils'
import type { OrgInviteRole, OrgRole } from '@/types/org'

export function OrganizationSettings() {
  const { user, currentOrg, refreshOrgs, setCurrentOrg, orgs } = useAuth()

  // 훅은 항상 호출되도록 순서 고정 — 조건부 return 은 아래에서
  const membersQuery = useOrgMembers(currentOrg?.id)
  const invitationsQuery = useOrgInvitations(currentOrg?.id)
  const updateOrg = useUpdateOrg()
  const deleteOrg = useDeleteOrg()
  const inviteMember = useInviteMember()
  const cancelInvitation = useCancelInvitation()
  const removeMember = useRemoveMember()
  const updateRole = useUpdateMemberRole()

  const isAdmin = currentOrg?.role === 'owner' || currentOrg?.role === 'admin'
  const isOwner = currentOrg?.role === 'owner'

  // 조직 이름 편집 form
  const [orgName, setOrgName] = useState(currentOrg?.name ?? '')
  useEffect(() => {
    setOrgName(currentOrg?.name ?? '')
  }, [currentOrg?.id, currentOrg?.name])
  const nameDirty = currentOrg && orgName.trim() !== currentOrg.name

  // 초대 form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrgInviteRole>('member')

  // 확인 다이얼로그들
  const [deleteOrgOpen, setDeleteOrgOpen] = useState(false)
  const [leaveOrgOpen, setLeaveOrgOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; display: string } | null>(null)

  // useMemo 로 안정화 — members 참조가 매 렌더마다 새 배열이면 아래 useMemo deps 가 무의미해지기 때문
  const members = useMemo(
    () => membersQuery.data ?? [],
    [membersQuery.data]
  )
  const invitations = invitationsQuery.data ?? []

  // 마지막 owner 탈퇴 방지 경고용
  const ownerCount = useMemo(
    () => members.filter((m) => m.role === 'owner').length,
    [members]
  )
  const isLastOwner = isOwner && ownerCount <= 1

  // 조건부 렌더는 훅 호출 이후
  if (!currentOrg) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          현재 조직이 설정되지 않았습니다.
        </CardContent>
      </Card>
    )
  }

  const handleRename = async () => {
    const name = orgName.trim()
    if (!name || !currentOrg) return
    if (name === currentOrg.name) return
    try {
      await updateOrg.mutateAsync({ id: currentOrg.id, name })
      refreshOrgs()
    } catch {
      /* onError toast */
    }
  }

  const handleInvite = async () => {
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return
    if (!isValidEmail(email)) {
      toast.error('이메일 형식이 올바르지 않습니다.')
      return
    }
    // 이미 멤버인지 프런트에서 빠르게 거른다 (RLS 에선 insert 후 trigger 에서 걸러짐)
    if (members.some((m) => m.email?.toLowerCase() === email)) {
      toast.error('이미 조직에 속한 멤버입니다.')
      return
    }
    try {
      await inviteMember.mutateAsync({ orgId: currentOrg.id, email, role: inviteRole })
      setInviteEmail('')
      setInviteRole('member')
    } catch {
      /* onError toast */
    }
  }

  const handleCancelInvite = async (id: string) => {
    try {
      await cancelInvitation.mutateAsync({ id, orgId: currentOrg.id })
    } catch {
      /* onError toast */
    }
  }

  const handleRoleChange = async (userId: string, role: OrgRole) => {
    try {
      await updateRole.mutateAsync({ orgId: currentOrg.id, userId, role })
    } catch {
      /* onError toast */
    }
  }

  const handleRemoveMember = async () => {
    if (!removeTarget) return
    try {
      await removeMember.mutateAsync({ orgId: currentOrg.id, userId: removeTarget.userId })
      setRemoveTarget(null)
    } catch {
      /* onError toast */
    }
  }

  const handleLeaveOrg = async () => {
    if (!user) return
    try {
      await removeMember.mutateAsync({ orgId: currentOrg.id, userId: user.id })
      // 다음 조직으로 이동 — 남은 조직이 있으면 첫 번째로, 없으면 null 로 두면
      // AuthContext 의 useEffect 가 자동 교정
      const other = orgs.find((o) => o.id !== currentOrg.id)
      if (other) setCurrentOrg(other)
      refreshOrgs()
      setLeaveOrgOpen(false)
    } catch {
      /* onError toast */
    }
  }

  const handleDeleteOrg = async () => {
    try {
      await deleteOrg.mutateAsync(currentOrg.id)
      // 현재 조직이 삭제됐으므로 다른 조직으로 이동 — AuthContext useEffect 가 교정
      refreshOrgs()
      setDeleteOrgOpen(false)
    } catch {
      /* onError toast */
    }
  }

  const roleLabel = (r: OrgRole) => (r === 'owner' ? '오너' : r === 'admin' ? '관리자' : '멤버')
  const roleBadgeVariant = (r: OrgRole): 'default' | 'secondary' | 'outline' =>
    r === 'owner' ? 'default' : r === 'admin' ? 'secondary' : 'outline'

  return (
    <div className="space-y-6">
      {/* 1. 조직 정보 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            조직 정보
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-name">조직 이름</Label>
            <div className="flex items-center gap-2">
              <Input
                id="org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                disabled={!isAdmin}
                className="max-w-md"
              />
              {isAdmin && (
                <Button
                  size="sm"
                  onClick={handleRename}
                  disabled={!nameDirty || updateOrg.isPending}
                >
                  <Save className="w-3.5 h-3.5 mr-1.5" />
                  저장
                </Button>
              )}
            </div>
            {!isAdmin && (
              <p className="text-xs text-muted-foreground">
                관리자 이상만 수정할 수 있습니다.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
            <div>
              <p className="font-medium text-foreground">내 역할</p>
              <p>{roleLabel(currentOrg.role)}</p>
            </div>
            <div>
              <p className="font-medium text-foreground">생성일</p>
              <p>{formatDate(currentOrg.created_at)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. 멤버 초대 (admin+) */}
      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserPlus className="w-4 h-4" />
              멤버 초대
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              이메일로 초대 레코드를 생성합니다. 해당 이메일로 로그인하면 조직에
              자동으로 합류됩니다.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[240px] space-y-1.5">
                <Label htmlFor="invite-email">이메일</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && inviteEmail.trim()) handleInvite()
                  }}
                />
              </div>
              <div className="w-32 space-y-1.5">
                <Label>역할</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(v) => setInviteRole(v as OrgInviteRole)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">멤버</SelectItem>
                    <SelectItem value="admin">관리자</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleInvite}
                disabled={!inviteEmail.trim() || inviteMember.isPending}
              >
                <Mail className="w-3.5 h-3.5 mr-1.5" />
                {inviteMember.isPending ? '초대 중...' : '초대'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3. 대기 중 초대 (admin+) */}
      {isAdmin && invitations.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="w-4 h-4" />
              대기 중 초대 ({invitations.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {roleLabel(inv.role)} · {formatDate(inv.created_at)} 초대
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCancelInvite(inv.id)}
                  className="shrink-0 text-destructive hover:text-destructive"
                  disabled={cancelInvitation.isPending}
                >
                  <XCircle className="w-3.5 h-3.5 mr-1" />
                  취소
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 4. 멤버 목록 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">멤버 ({members.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {membersQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">멤버가 없습니다.</p>
          ) : (
            members.map((m) => {
              const isMe = m.user_id === user?.id
              const canManage = isAdmin && !isMe
              return (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {m.display_name || m.email}
                      </p>
                      {isMe && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                          나
                        </Badge>
                      )}
                      <Badge
                        variant={roleBadgeVariant(m.role)}
                        className="text-[10px] h-4 px-1.5"
                      >
                        {roleLabel(m.role)}
                      </Badge>
                    </div>
                    {m.display_name && (
                      <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {formatDate(m.joined_at)} 합류
                    </p>
                  </div>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {m.role !== 'owner' && (
                          <DropdownMenuItem
                            onClick={() => handleRoleChange(m.user_id, 'owner')}
                          >
                            오너로 변경
                          </DropdownMenuItem>
                        )}
                        {m.role !== 'admin' && (
                          <DropdownMenuItem
                            onClick={() => handleRoleChange(m.user_id, 'admin')}
                          >
                            관리자로 변경
                          </DropdownMenuItem>
                        )}
                        {m.role !== 'member' && (
                          <DropdownMenuItem
                            onClick={() => handleRoleChange(m.user_id, 'member')}
                          >
                            멤버로 변경
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() =>
                            setRemoveTarget({
                              userId: m.user_id,
                              display: m.display_name || m.email || '',
                            })
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" />
                          조직에서 제거
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* 5. 위험 영역 */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-4 h-4" />
            위험 영역
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 탈퇴 */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">조직에서 탈퇴</p>
              <p className="text-xs text-muted-foreground">
                {isLastOwner
                  ? '마지막 오너는 탈퇴할 수 없습니다. 먼저 다른 멤버를 오너로 승격해주세요.'
                  : '이 조직의 공유 데이터에 더 이상 접근할 수 없게 됩니다.'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLeaveOrgOpen(true)}
              disabled={isLastOwner}
              className="shrink-0"
            >
              <LogOut className="w-3.5 h-3.5 mr-1.5" />
              탈퇴
            </Button>
          </div>

          {/* 삭제 — owner 만 */}
          {isOwner && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">조직 삭제</p>
                <p className="text-xs text-muted-foreground">
                  조직과 연관된 모든 연락처·그룹·템플릿·캠페인이 영구 삭제됩니다.
                  이 작업은 되돌릴 수 없습니다.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteOrgOpen(true)}
                className="shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                삭제
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 확인 다이얼로그들 */}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="멤버 제거"
        description={`${removeTarget?.display ?? ''} 님을 조직에서 제거할까요? 해당 멤버가 만든 연락처/템플릿/캠페인은 유지되지만 오너만 볼 수 있게 됩니다.`}
        confirmLabel="제거"
        variant="destructive"
        onConfirm={handleRemoveMember}
        loading={removeMember.isPending}
      />

      <ConfirmDialog
        open={leaveOrgOpen}
        onOpenChange={setLeaveOrgOpen}
        title="조직에서 탈퇴"
        description={`정말 ${currentOrg.name} 에서 탈퇴할까요? 탈퇴 후에는 이 조직의 데이터에 접근할 수 없습니다.`}
        confirmLabel="탈퇴"
        variant="destructive"
        onConfirm={handleLeaveOrg}
        loading={removeMember.isPending}
      />

      <ConfirmDialog
        open={deleteOrgOpen}
        onOpenChange={setDeleteOrgOpen}
        title="조직 삭제"
        description={`${currentOrg.name} 을(를) 삭제하면 모든 구성원과 공유 데이터가 영구 삭제됩니다. 정말 진행할까요?`}
        confirmLabel="영구 삭제"
        variant="destructive"
        onConfirm={handleDeleteOrg}
        loading={deleteOrg.isPending}
      />
    </div>
  )
}
