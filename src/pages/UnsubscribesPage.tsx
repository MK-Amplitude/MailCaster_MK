// ============================================================
// UnsubscribesPage — 수신거부 목록 관리
// ------------------------------------------------------------
// 기능:
//   - 전체 수신거부 리스트 (검색 + 정렬)
//   - 개별 추가: 이메일 + 사유 (선택)
//   - 개별 해제 / 일괄 해제
//
// 데이터 출처:
//   - mailcaster.unsubscribes (전역 수신거부 테이블)
//   - 플래그 동기화는 useUnsubscribes 훅이 처리 → contacts.is_unsubscribed
//
// 주의:
//   - 발송 경로(useSendCampaign)는 is_unsubscribed=true 인 연락처를 스킵.
//     즉 수신거부 해제 시 이 연락처는 다시 발송 대상이 된다. UI 에서
//     사용자에게 명시적으로 알림.
// ============================================================

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
  type Unsubscribe,
} from '@/hooks/useUnsubscribes'
import { Ban, Plus, Search, Trash2, Undo2 } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'

export default function UnsubscribesPage() {
  const { data: list = [], isLoading } = useUnsubscribes()
  const createMut = useCreateUnsubscribe()
  const deleteMut = useDeleteUnsubscribe()
  const bulkDeleteMut = useBulkDeleteUnsubscribes()

  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Unsubscribe | null>(null)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 검색 — email / reason 부분 일치, case-insensitive
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.reason ?? '').toLowerCase().includes(q),
    )
  }, [list, query])

  // 필터 결과와 selection 동기화 — 필터 바뀌면 화면에 없는 건 자동 해제
  const visibleIds = new Set(filtered.map((u) => u.id))
  const effectiveSelected = [...selected].filter((id) => visibleIds.has(id))

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((u) => selected.has(u.id))

  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((u) => u.id)))
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
    const items = list.filter((u) => selected.has(u.id))
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
      <div className="px-6 py-4 border-b flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Ban className="w-5 h-5" />
            수신거부 관리
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            총 {list.length}명이 수신거부 상태입니다. 이 목록의 이메일은 모든
            캠페인에서 자동 제외됩니다.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="w-4 h-4 mr-1.5" />
          추가
        </Button>
      </div>

      <div className="px-6 py-3 border-b">
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이메일 또는 사유 검색..."
            className="pl-8 h-9"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={Ban}
            title="수신거부가 없습니다"
            description="사용자가 수신거부 링크를 클릭하거나 수동으로 추가할 때 이 목록에 쌓입니다."
            action={{ label: '수동 추가', onClick: () => setAddOpen(true) }}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title="검색 결과 없음"
            description={`"${query}" 에 해당하는 수신거부가 없습니다.`}
          />
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={toggleAll}
                    aria-label="모두 선택"
                  />
                </TableHead>
                <TableHead>이메일</TableHead>
                <TableHead className="w-[40%]">사유</TableHead>
                <TableHead className="w-[180px]">수신거부 시각</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow
                  key={u.id}
                  data-state={selected.has(u.id) ? 'selected' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      checked={selected.has(u.id)}
                      onCheckedChange={() => toggleOne(u.id)}
                      aria-label={`${u.email} 선택`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {u.reason || <span className="italic">—</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(u.unsubscribed_at)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setToDelete(u)}
                      title="수신거부 해제"
                    >
                      <Undo2 className="w-3.5 h-3.5 mr-1" />
                      해제
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
            이 이메일로의 캠페인 발송이 영구적으로 차단됩니다. (해제 전까지)
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="uns-email">이메일 *</Label>
            <Input
              id="uns-email"
              type="email"
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
