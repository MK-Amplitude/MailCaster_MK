// ============================================================
// UnsubscribesPage — 수신거부 목록 관리 (조직 기반)
// ------------------------------------------------------------
// 기능:
//   - 조직 전체 또는 내가 등록한 것만 보기 (scope toggle)
//   - 개별 추가: 이메일 + 사유 (선택)
//   - 개별 해제 / 일괄 해제 — 본인 등록 또는 org admin 만 가능 (RLS)
//
// 데이터 출처:
//   - mailcaster.unsubscribes — (org_id, email) UNIQUE (018 이후)
//   - 플래그 동기화는 useUnsubscribes 훅이 처리 → contacts.is_unsubscribed
//
// 주의:
//   - 발송 경로(useSendCampaign)는 is_unsubscribed=true 인 연락처를 스킵.
//     조직 전체에서 공유되므로, 한 명이 등록하면 모든 멤버의 발송에서 제외됨.
//   - 수신거부 해제 시 이 연락처는 다시 발송 대상이 되므로 UI 에서 명시적으로 알림.
// ============================================================

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { BulkActionBar } from '@/components/common/BulkActionBar'
import {
  useUnsubscribes,
  useCreateUnsubscribe,
  useDeleteUnsubscribe,
  useBulkDeleteUnsubscribes,
  type UnsubscribeWithOwner,
  type UnsubscribeScope,
} from '@/hooks/useUnsubscribes'
import { useAuth } from '@/hooks/useAuth'
import { Ban, Plus, Search, Trash2, Undo2, User } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'

export default function UnsubscribesPage() {
  const { user, isOrgAdmin } = useAuth()
  const [scope, setScope] = useState<UnsubscribeScope>('org')
  const { data: list = [], isLoading } = useUnsubscribes(scope)
  const createMut = useCreateUnsubscribe()
  const deleteMut = useDeleteUnsubscribe()
  const bulkDeleteMut = useBulkDeleteUnsubscribes()

  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [toDelete, setToDelete] = useState<UnsubscribeWithOwner | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // RLS: 본인 등록 또는 org admin 만 해제 가능 — UI 도 일치
  const canMutate = (u: UnsubscribeWithOwner) => u.user_id === user?.id || isOrgAdmin

  // 검색 — email / reason / 등록자 부분 일치, case-insensitive
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.reason ?? '').toLowerCase().includes(q) ||
        (u.profiles?.display_name ?? '').toLowerCase().includes(q) ||
        (u.profiles?.email ?? '').toLowerCase().includes(q),
    )
  }, [list, query])

  // 선택 가능한 것만 — 내가 해제할 수 없는 row 는 체크박스에서 제외
  const mutableVisible = useMemo(
    () => filtered.filter(canMutate),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, user?.id, isOrgAdmin],
  )

  // 필터 결과와 selection 동기화 — 필터 바뀌면 화면에 없는 건 자동 해제
  const visibleIds = new Set(mutableVisible.map((u) => u.id))
  const effectiveSelected = [...selected].filter((id) => visibleIds.has(id))

  const allVisibleSelected =
    mutableVisible.length > 0 && mutableVisible.every((u) => selected.has(u.id))

  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(mutableVisible.map((u) => u.id)))
    }
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkDelete = async () => {
    const items = list.filter((u) => selected.has(u.id) && canMutate(u))
    try {
      await bulkDeleteMut.mutateAsync(items)
      setSelected(new Set())
      setBulkConfirmOpen(false)
    } catch {
      // toast in hook
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b flex items-start sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Ban className="w-5 h-5 shrink-0" />
            수신거부 관리
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {scope === 'mine'
              ? `내가 등록한 ${list.length}건`
              : `조직 전체에서 ${list.length}명이 수신거부 상태입니다.`}{' '}
            이 목록의 이메일은 모든 캠페인에서 자동 제외됩니다.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} className="shrink-0">
          <Plus className="w-4 h-4 mr-1.5" />
          추가
        </Button>
      </div>

      <div className="px-4 sm:px-6 py-3 border-b flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이메일·사유·등록자 검색..."
            className="pl-8 h-9"
          />
        </div>
        <Select value={scope} onValueChange={(v) => setScope(v as UnsubscribeScope)}>
          <SelectTrigger className="h-9 w-28 text-sm shrink-0" title="범위">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mine">내 것</SelectItem>
            <SelectItem value="org">조직 전체</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 sm:p-6 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={Ban}
            title={
              scope === 'mine'
                ? '내가 등록한 수신거부가 없습니다'
                : '수신거부가 없습니다'
            }
            description={
              scope === 'mine'
                ? '조직 전체 보기로 전환하면 다른 멤버가 등록한 수신거부도 볼 수 있습니다.'
                : '사용자가 수신거부 링크를 클릭하거나 수동으로 추가할 때 이 목록에 쌓입니다.'
            }
            action={{ label: '수동 추가', onClick: () => setAddOpen(true) }}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="검색 결과 없음"
            description={`"${query}" 에 해당하는 수신거부가 없습니다.`}
          />
        ) : (
          // overflow-x-auto: 좁은 뷰포트에서 가로 스크롤 허용 (테이블 컬럼이 뷰포트를
          // 넘어설 때 레이아웃이 깨지지 않도록). 모바일에서는 "사유", "등록자" 컬럼을
          // 숨겨 스크롤 없이도 핵심 정보(이메일 + 시각 + 해제버튼)만 보이도록 함.
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAll}
                      aria-label="모두 선택"
                      disabled={mutableVisible.length === 0}
                    />
                  </TableHead>
                  <TableHead>이메일</TableHead>
                  <TableHead className="w-[30%] hidden md:table-cell">사유</TableHead>
                  <TableHead className="w-[140px] hidden lg:table-cell">등록자</TableHead>
                  <TableHead className="w-[160px] hidden sm:table-cell">수신거부 시각</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => {
                  const mutable = canMutate(u)
                  const ownerLabel =
                    u.profiles?.display_name || u.profiles?.email || '알 수 없음'
                  const isMine = u.user_id === user?.id
                  return (
                    <TableRow
                      key={u.id}
                      data-state={selected.has(u.id) ? 'selected' : undefined}
                    >
                      <TableCell>
                        {mutable ? (
                          <Checkbox
                            checked={selected.has(u.id)}
                            onCheckedChange={() => toggleOne(u.id)}
                            aria-label={`${u.email} 선택`}
                          />
                        ) : (
                          // 권한 없는 row 는 자리만 유지 (레이아웃 안정)
                          <div className="w-4 h-4" />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-0.5">
                          <span className="truncate max-w-[200px] sm:max-w-none">{u.email}</span>
                          {/* 모바일에서 사유/시각/등록자가 숨겨지므로 이메일 셀 안에 간소화 버전 노출 */}
                          <div className="sm:hidden text-[10px] text-muted-foreground tabular-nums">
                            {formatDateTime(u.unsubscribed_at)}
                            {u.reason && <span className="ml-1">· {u.reason}</span>}
                          </div>
                          {!isMine && (
                            <div className="lg:hidden text-[10px] text-muted-foreground">
                              등록자: {ownerLabel}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm hidden md:table-cell">
                        {u.reason || <span className="italic">—</span>}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {isMine ? (
                          <span className="text-xs text-muted-foreground italic">나</span>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-[10px] py-0 px-1.5 h-5 max-w-[140px]"
                            title={u.profiles?.email ?? ownerLabel}
                          >
                            <User className="w-2.5 h-2.5 mr-1 shrink-0" />
                            <span className="truncate">{ownerLabel}</span>
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums hidden sm:table-cell">
                        {formatDateTime(u.unsubscribed_at)}
                      </TableCell>
                      <TableCell>
                        {mutable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 md:h-7 text-xs"
                            onClick={() => setToDelete(u)}
                            title={isMine ? '수신거부 해제' : '수신거부 해제 (관리자 권한)'}
                          >
                            <Undo2 className="w-3.5 h-3.5 mr-1" />
                            해제
                          </Button>
                        ) : (
                          // 자리만 유지
                          <div className="h-9 md:h-7" />
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 추가 다이얼로그 */}
      <AddUnsubscribeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmit={async (email, reason) => {
          try {
            await createMut.mutateAsync({ email, reason })
            setAddOpen(false)
          } catch {
            // toast in hook
          }
        }}
        loading={createMut.isPending}
      />

      {/* 개별 해제 확인 */}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(v) => !v && setToDelete(null)}
        title="수신거부 해제"
        description={
          toDelete
            ? `${toDelete.email} 을(를) 수신거부 목록에서 제거하면 이 이메일로 다시 발송이 가능해집니다. 계속하시겠습니까?`
            : ''
        }
        confirmLabel="해제"
        variant="destructive"
        loading={deleteMut.isPending}
        onConfirm={async () => {
          if (!toDelete) return
          try {
            await deleteMut.mutateAsync(toDelete)
            setToDelete(null)
          } catch {
            // toast in hook
          }
        }}
      />

      {/* 일괄 해제 확인 */}
      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title={`${effectiveSelected.length}개 수신거부 해제`}
        description={`선택한 ${effectiveSelected.length}개의 이메일이 수신거부 목록에서 제거됩니다. 이들에게는 다시 캠페인이 발송될 수 있습니다.`}
        confirmLabel="일괄 해제"
        variant="destructive"
        loading={bulkDeleteMut.isPending}
        onConfirm={handleBulkDelete}
      />

      {/* 선택된 것이 있으면 바닥 플로팅 바 */}
      <BulkActionBar
        selectedCount={effectiveSelected.length}
        onClear={() => setSelected(new Set())}
        actions={[
          {
            label: '해제',
            icon: <Trash2 className="w-3.5 h-3.5 mr-1" />,
            variant: 'destructive',
            onClick: () => setBulkConfirmOpen(true),
          },
        ]}
      />
    </div>
  )
}

// ------------------------------------------------------------
// 수신거부 수동 추가 다이얼로그
// ------------------------------------------------------------
function AddUnsubscribeDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (email: string, reason: string | undefined) => void | Promise<void>
  loading: boolean
}) {
  const [email, setEmail] = useState('')
  const [reason, setReason] = useState('')

  // 다이얼로그 열릴 때 초기화
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setEmail('')
      setReason('')
    }
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>수신거부 추가</DialogTitle>
          <DialogDescription>
            이 이메일로의 캠페인 발송이 조직 전체에서 영구적으로 차단됩니다. (해제 전까지)
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="uns-email">이메일 *</Label>
            <Input
              id="uns-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uns-reason">사유 (선택)</Label>
            <Textarea
              id="uns-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="예: 사용자 직접 요청"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            취소
          </Button>
          <Button
            onClick={() => onSubmit(email, reason.trim() || undefined)}
            disabled={loading || !email.trim()}
          >
            {loading ? '추가 중...' : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
