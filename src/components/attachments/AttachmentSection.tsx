// 재사용 가능한 첨부 파일 섹션
//
// - 템플릿/캠페인 양쪽에서 동일 UI 사용
// - 부모가 attachments 배열을 소유 (controlled) — 저장 시점에 template/campaign_attachments 링크 삽입 담당
// - 이 컴포넌트는 업로드/Drive picker/삭제만 담당
// - 캠페인 모드(showSizeGauge) 에서는 총 크기 게이지 + 25MB 초과 시 link fallback 배지 표시

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/components/common/EmptyState'
import { useUploadAttachment, usePickDriveFile } from '@/hooks/useAttachments'
import { DriveFilePicker } from './DriveFilePicker'
import {
  Paperclip,
  Upload,
  HardDrive,
  X,
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  FileArchive,
  Film,
  Music,
  FileSpreadsheet,
  Loader2,
  Link as LinkIcon,
  ExternalLink,
} from 'lucide-react'
import {
  formatBytes,
  GMAIL_ATTACHMENT_LIMIT,
  GMAIL_ATTACHMENT_SAFE_THRESHOLD,
  cn,
} from '@/lib/utils'
// 참고: overLimit/nearLimit 기준은 SAFE_THRESHOLD(18MB)
//   — base64 인코딩 시 약 1.333배 팽창하므로 실제 Gmail 25MB 제한에 도달하기 전에 fallback 발동.
//   useSendCampaign.ts 의 deliveryMode 결정 로직과 동일한 threshold 사용.
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']

interface AttachmentSectionProps {
  /** 현재 링크된 첨부 (controlled) */
  attachments: DriveAttachmentRow[]
  /**
   * 첨부 변경 setter — React useState dispatch 와 동일 시그니처.
   * 비동기 업로드/picker 중 stale closure 를 방지하려면 functional updater 필요.
   */
  onChange: Dispatch<SetStateAction<DriveAttachmentRow[]>>
  /** 총 크기 게이지 + 25MB fallback 배지 표시 (캠페인 용) */
  showSizeGauge?: boolean
  /** 비활성화 (예: 템플릿 저장 전) */
  disabled?: boolean
  /** disabled 상태 안내 문구 */
  disabledHint?: string
  /**
   * 업로드/Drive pick 진행 중 여부를 부모에게 알림 — 저장 버튼 disabled 처리에 활용.
   * isBusy 가 변할 때마다 호출.
   */
  onBusyChange?: (busy: boolean) => void
}

export function AttachmentSection({
  attachments,
  onChange,
  showSizeGauge = false,
  disabled = false,
  disabledHint,
  onBusyChange,
}: AttachmentSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const upload = useUploadAttachment()
  const pick = usePickDriveFile()

  const totalSize = attachments.reduce((sum, a) => sum + (a.file_size ?? 0), 0)
  // SAFE_THRESHOLD(18MB) 기준 — 실제 fallback 발동점과 일치
  const overLimit = totalSize > GMAIL_ATTACHMENT_SAFE_THRESHOLD
  const nearLimit = totalSize > GMAIL_ATTACHMENT_SAFE_THRESHOLD * 0.8 && !overLimit
  const percent = Math.min(100, (totalSize / GMAIL_ATTACHMENT_SAFE_THRESHOLD) * 100)

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    // S11: 병렬 업로드 — 여러 파일을 동시에 올려 속도 개선.
    // Promise.allSettled 로 개별 실패는 나머지 성공에 영향 없게 처리.
    // (useUploadAttachment 의 onError 에서 각 실패에 대해 토스트 뜸)
    const results = await Promise.allSettled(
      Array.from(files).map((file) => upload.mutateAsync({ file }))
    )
    const added: DriveAttachmentRow[] = []
    for (const res of results) {
      if (res.status === 'fulfilled') added.push(res.value)
    }

    if (added.length > 0) {
      // functional updater — 병렬 업로드/픽커 액션 중 stale closure 방지
      onChange((prev) => {
        const seen = new Set(prev.map((a) => a.id))
        const novel = added.filter((r) => !seen.has(r.id))
        return novel.length > 0 ? [...prev, ...novel] : prev
      })
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDrivePick = async (driveFileId: string) => {
    // 중복 체크는 최종적으로 functional updater 안에서 — 여기선 UX 용 skip
    if (attachments.some((a) => a.drive_file_id === driveFileId)) {
      setPickerOpen(false)
      return
    }
    try {
      const row = await pick.mutateAsync({ driveFileId })
      onChange((prev) =>
        prev.some((a) => a.id === row.id || a.drive_file_id === row.drive_file_id)
          ? prev
          : [...prev, row]
      )
    } finally {
      setPickerOpen(false)
    }
  }

  const handleRemove = (id: string) => {
    onChange((prev) => prev.filter((a) => a.id !== id))
  }

  const isBusy = upload.isPending || pick.isPending

  // S7: busy 상태 변화를 부모에게 통지 — TemplateFormDialog 등의 저장 버튼 제어에 사용
  useEffect(() => {
    onBusyChange?.(isBusy)
  }, [isBusy, onBusyChange])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5">
          <Paperclip className="w-3.5 h-3.5" />
          첨부 파일 ({attachments.length})
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isBusy}
          >
            {upload.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 mr-1" />
            )}
            파일 업로드
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setPickerOpen(true)}
            disabled={disabled || isBusy}
          >
            <HardDrive className="w-3.5 h-3.5 mr-1" />
            Drive 에서 선택
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFilesSelected(e.target.files)}
      />

      {disabled && disabledHint && (
        <Card className="bg-muted/30">
          <CardContent className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {disabledHint}
          </CardContent>
        </Card>
      )}

      {!disabled && attachments.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Paperclip}
              title="첨부 파일 없음"
              description="파일을 업로드하거나 Google Drive 에서 기존 파일을 선택하세요."
              className="py-8"
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {attachments.map((a) => (
            <AttachmentCard key={a.id} attachment={a} onRemove={handleRemove} disabled={disabled} />
          ))}
        </div>
      )}

      {showSizeGauge && attachments.length > 0 && (
        <Card
          className={cn(
            overLimit && 'border-amber-300 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/20',
            nearLimit && 'border-yellow-300 bg-yellow-50/40 dark:border-yellow-800/60 dark:bg-yellow-950/20'
          )}
        >
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">총 첨부 용량</span>
              <span className="font-medium">
                {formatBytes(totalSize)} / {formatBytes(GMAIL_ATTACHMENT_SAFE_THRESHOLD)}
                <span className="text-muted-foreground ml-1">
                  (Gmail {formatBytes(GMAIL_ATTACHMENT_LIMIT)} 한도)
                </span>
              </span>
            </div>
            <Progress value={percent} className="h-1.5" />
            {overLimit ? (
              <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <LinkIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  Gmail 안전 용량({formatBytes(GMAIL_ATTACHMENT_SAFE_THRESHOLD)}) 초과 — 발송 시 자동으로{' '}
                  <strong>Drive 공유 링크</strong> 로 전환됩니다.
                </span>
              </div>
            ) : nearLimit ? (
              <div className="flex items-start gap-1.5 text-xs text-yellow-700 dark:text-yellow-300">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Gmail 안전 용량에 근접했습니다 — 파일 추가 시 링크로 전환될 수 있습니다.</span>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                모두 메일 첨부로 발송됩니다.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <DriveFilePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handleDrivePick}
        excludeDriveIds={attachments.map((a) => a.drive_file_id)}
        busy={pick.isPending}
      />
    </div>
  )
}

// ------------------------------------------------------------
// 개별 첨부 카드
// ------------------------------------------------------------

function AttachmentCard({
  attachment,
  onRemove,
  disabled,
}: {
  attachment: DriveAttachmentRow
  onRemove: (id: string) => void
  disabled?: boolean
}) {
  const Icon = iconForMime(attachment.mime_type)
  const deleted = !!attachment.deleted_from_drive_at

  return (
    <Card className={deleted ? 'border-destructive/60' : undefined}>
      <CardContent className="p-2.5 flex items-center gap-2.5">
        <div
          className={cn(
            'w-8 h-8 rounded flex items-center justify-center shrink-0',
            deleted ? 'bg-destructive/10' : 'bg-muted'
          )}
        >
          <Icon
            className={cn(
              'w-4 h-4',
              deleted ? 'text-destructive' : 'text-muted-foreground'
            )}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate flex items-center gap-1.5">
            {attachment.file_name}
            {attachment.source === 'picked' && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                Drive
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <span>{formatBytes(attachment.file_size)}</span>
            {attachment.web_view_link && (
              <a
                href={attachment.web_view_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                Drive 에서 열기
              </a>
            )}
            {deleted && (
              <span className="text-destructive flex items-center gap-0.5">
                <AlertTriangle className="w-3 h-3" />
                Drive 에서 삭제됨
              </span>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
          onClick={() => onRemove(attachment.id)}
          disabled={disabled}
        >
          <X className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------
// mime type → 아이콘 매핑
// ------------------------------------------------------------

function iconForMime(mime: string | null) {
  const m = (mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return ImageIcon
  if (m.startsWith('video/')) return Film
  if (m.startsWith('audio/')) return Music
  if (m.includes('zip') || m.includes('compressed') || m.includes('tar') || m.includes('rar'))
    return FileArchive
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return FileSpreadsheet
  return FileText
}
