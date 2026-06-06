import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSequenceOptions, useEnrollGroup } from '@/hooks/useSequences'

interface EnrollGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string | null
  groupName?: string
}

// 그룹 전체를 시퀀스에 일괄 등록 (069). enroll_group_in_sequence RPC 사용 —
// 멤버 id 를 클라이언트로 끌어오지 않고 서버에서 등록(대형 그룹 안전).
// 수신거부/반송/이미 등록된 연락처는 자동 제외.
export function EnrollGroupDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
}: EnrollGroupDialogProps) {
  const { data: sequences = [], isLoading } = useSequenceOptions()
  const enrollGroup = useEnrollGroup()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const handleClose = () => {
    onOpenChange(false)
    setSelectedId(null)
  }

  const handleConfirm = async () => {
    if (!selectedId || !groupId) return
    await enrollGroup.mutateAsync({ sequenceId: selectedId, groupId })
    handleClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : handleClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>그룹을 시퀀스에 등록</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {groupName ? `"${groupName}" ` : ''}그룹의 모든 연락처를 등록할 시퀀스를 선택하세요.
            수신거부·반송·이미 등록된 연락처는 자동 제외됩니다.
          </p>
        </DialogHeader>

        <ScrollArea className="h-[300px] border rounded-md">
          <div className="p-1.5">
            {isLoading ? (
              <div className="p-4 text-sm text-center text-muted-foreground">로딩 중...</div>
            ) : sequences.length === 0 ? (
              <div className="p-4 text-sm text-center text-muted-foreground">
                활성 시퀀스가 없습니다. 시퀀스 메뉴에서 먼저 만들어주세요.
              </div>
            ) : (
              sequences.map((s) => {
                const active = selectedId === s.id
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left',
                      active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                    )}
                  >
                    <Workflow
                      className={cn(
                        'w-3.5 h-3.5 shrink-0',
                        active ? 'text-primary-foreground' : 'text-muted-foreground'
                      )}
                    />
                    <span className="truncate">{s.name}</span>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={enrollGroup.isPending}>
            취소
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedId || enrollGroup.isPending}>
            {enrollGroup.isPending ? '등록 중...' : '등록'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
