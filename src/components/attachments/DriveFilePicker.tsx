// Google Drive 파일 picker 다이얼로그
//
// useDriveFileListQuery 로 페이지 단위 목록 로드 + 검색 + mime 필터.
// 사용자가 파일 한 개 선택 → onSelect(driveFileId) 호출 → 부모가 usePickDriveFile 로 DB 등록.

import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useDriveFileListQuery } from '@/hooks/useAttachments'
import { formatBytes, formatRelative } from '@/lib/utils'
import { Search, HardDrive, Check, Loader2, ExternalLink } from 'lucide-react'

interface DriveFilePickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (driveFileId: string) => void
  /** 이미 선택된 파일은 체크 표시 */
  excludeDriveIds?: string[]
  /** 선택 처리 중인지 (부모의 usePickDriveFile.isPending) */
  busy?: boolean
}

export function DriveFilePicker({
  open,
  onOpenChange,
  onSelect,
  excludeDriveIds = [],
  busy = false,
}: DriveFilePickerProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null)

  // query → debounced 400ms
  useDebounced(query, 400, setDebounced)

  // 다이얼로그가 닫혀있는 동안에는 Drive API 호출 방지
  const { data, isLoading, isFetching, isError, error, refetch } = useDriveFileListQuery(
    { query: debounced, pageSize: 50 },
    open
  )

  // 다이얼로그 닫힘 → 검색어 초기화 (재열람 시 이전 상태 남지 않음)
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebounced('')
      setPendingSelectId(null)
    }
  }, [open])

  const excludeSet = new Set(excludeDriveIds)

  const handleSelect = async (driveFileId: string) => {
    setPendingSelectId(driveFileId)
    try {
      await onSelect(driveFileId)
    } finally {
      setPendingSelectId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="w-4 h-4" />
            Google Drive 에서 파일 선택
          </DialogTitle>
          <DialogDescription>
            내 Drive 의 파일을 검색해 첨부하세요. 선택한 파일은 원본 그대로 참조됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="파일 이름으로 검색..."
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="max-h-96 overflow-y-auto space-y-1 -mx-1 px-1">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : isError ? (
            <div className="p-6 text-center text-sm space-y-2">
              <div className="text-destructive">
                Drive 파일 목록 조회 실패
              </div>
              <div className="text-xs text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </div>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                다시 시도
              </Button>
            </div>
          ) : !data || data.files.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {debounced ? '검색 결과가 없습니다.' : 'Drive 에 파일이 없습니다.'}
            </div>
          ) : (
            data.files.map((f) => {
              const already = excludeSet.has(f.id)
              const selecting = pendingSelectId === f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={already || busy || selecting}
                  onClick={() => handleSelect(f.id)}
                  className="w-full flex items-center gap-3 p-2.5 rounded border text-left transition-colors hover:bg-accent disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {f.iconLink ? (
                    <img
                      src={f.iconLink}
                      alt=""
                      className="w-5 h-5 shrink-0"
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  ) : (
                    <HardDrive className="w-5 h-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{f.name}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>{formatBytes(f.size)}</span>
                      {f.modifiedTime && (
                        <span>· {formatRelative(f.modifiedTime)} 수정</span>
                      )}
                      {f.webViewLink && (
                        <a
                          href={f.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  {already ? (
                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                      <Check className="w-3 h-3 mr-0.5" />
                      선택됨
                    </Badge>
                  ) : selecting ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : null}
                </button>
              )
            })
          )}

          {isFetching && !isLoading && (
            <div className="flex items-center justify-center py-2 text-xs text-muted-foreground gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              불러오는 중...
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
          <span>
            {data ? `${data.files.length}개 표시` : ''}
            {data?.nextPageToken && ' (추가 페이지 있음 — 검색어로 좁혀주세요)'}
          </span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------
// debounce hook — 콜백을 ref 에 stash 해서 인라인/비-메모 콜백 안전
// ------------------------------------------------------------

function useDebounced<T>(value: T, delayMs: number, onDebounced: (v: T) => void) {
  const cbRef = useRef(onDebounced)
  cbRef.current = onDebounced
  useEffect(() => {
    const id = setTimeout(() => cbRef.current(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
}
