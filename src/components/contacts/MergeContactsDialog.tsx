// 중복 연락처 병합 다이얼로그 — 선택된 연락처 중 "대표" 1명을 고르면
// 나머지의 발송/수신 이력·그룹·시퀀스 참조가 대표로 이전되고 삭제된다.
// 대표의 빈 필드는 병합 대상의 값으로 자동 보완 (서버 RPC 정책).

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, Merge } from 'lucide-react'
import { useMergeContacts } from '@/hooks/useContacts'
import type { ContactWithGroups } from '@/types/contact'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 병합 후보 (2명 이상) — ContactsPage 의 선택 목록 */
  contacts: ContactWithGroups[]
  onDone?: () => void
}

export function MergeContactsDialog({ open, onOpenChange, contacts, onDone }: Props) {
  const merge = useMergeContacts()
  const [primaryId, setPrimaryId] = useState<string | null>(null)

  // 열릴 때마다 초기화 — 기본 대표는 첫 번째(최신 등록)
  useEffect(() => {
    if (open) setPrimaryId(contacts[0]?.id ?? null)
  }, [open, contacts])

  const handleMerge = async () => {
    if (!primaryId) return
    try {
      await merge.mutateAsync({
        primaryId,
        mergeIds: contacts.map((c) => c.id),
      })
      onOpenChange(false)
      onDone?.()
    } catch {
      // onError 토스트
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="w-4 h-4" /> 연락처 병합
          </DialogTitle>
          <DialogDescription>
            대표로 남길 연락처를 선택하세요. 나머지 {Math.max(0, contacts.length - 1)}명의
            발송·수신 이력, 그룹, 시퀀스가 대표로 이전된 후 삭제됩니다.
            대표의 빈 필드(회사·직책·전화 등)는 병합 대상의 값으로 자동 보완됩니다.
            이 작업은 되돌릴 수 없습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto space-y-1.5 py-1">
          {contacts.map((c) => (
            <label
              key={c.id}
              className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                primaryId === c.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/40'
              }`}
            >
              <input
                type="radio"
                name="merge-primary"
                className="mt-1"
                checked={primaryId === c.id}
                onChange={() => setPrimaryId(c.id)}
              />
              <div className="min-w-0 text-sm">
                <div className="font-medium truncate">
                  {c.name || '(이름 없음)'}{' '}
                  <span className="text-muted-foreground font-normal">{c.email}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {[c.company, c.department, c.job_title].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              {primaryId === c.id && (
                <span className="ml-auto shrink-0 text-xs text-primary font-medium">대표</span>
              )}
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merge.isPending}>
            취소
          </Button>
          <Button onClick={handleMerge} disabled={!primaryId || contacts.length < 2 || merge.isPending}>
            {merge.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {contacts.length - 1}명을 대표로 병합
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
