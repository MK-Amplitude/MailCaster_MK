// thread_messages row 한 건을 상세 보기 — 보낸 메일의 실제 본문/메타데이터.
// recipients table 아래 "팔로업/회신/전달 기록" 섹션의 행을 클릭하면 열린다.
//
// 보여주는 정보:
//   - 메타: 모드 (followup/reply/forward), 받는 사람, 제목, 발송 시각, 상태
//   - 오픈 추적: opened (Y/N), open_count, last_opened_at
//   - 본문 HTML (트래킹 픽셀은 DB 에 저장 안 했으므로 픽셀 fire 위험 없음)

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Reply, ReplyAll, Forward, Eye, EyeOff, CheckCircle2, XCircle, Clock } from 'lucide-react'
import type { ThreadMessageRow } from '@/hooks/useThreadMessages'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  message: ThreadMessageRow | null
}

const MODE_META: Record<
  ThreadMessageRow['mode'],
  { label: string; Icon: typeof Reply; color: string }
> = {
  followup: { label: '팔로업', Icon: Reply, color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  reply: { label: '회신', Icon: ReplyAll, color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
  forward: { label: '전달', Icon: Forward, color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
}

const STATUS_META: Record<
  ThreadMessageRow['status'],
  { label: string; Icon: typeof CheckCircle2; color: string }
> = {
  pending: { label: '발송 중', Icon: Clock, color: 'text-amber-600 dark:text-amber-400' },
  sent: { label: '발송 성공', Icon: CheckCircle2, color: 'text-green-600 dark:text-green-400' },
  failed: { label: '발송 실패', Icon: XCircle, color: 'text-red-600 dark:text-red-400' },
}

function formatTs(ts: string | null): string {
  if (!ts) return '-'
  return format(new Date(ts), 'yyyy-MM-dd HH:mm:ss', { locale: ko })
}

export function ThreadMessageDetailDialog({ open, onOpenChange, message }: Props) {
  if (!message) return null

  const modeMeta = MODE_META[message.mode]
  const statusMeta = STATUS_META[message.status]
  const ModeIcon = modeMeta.Icon
  const StatusIcon = statusMeta.Icon

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${modeMeta.color}`}
            >
              <ModeIcon className="w-3 h-3" />
              {modeMeta.label}
            </span>
            <span className="truncate">{message.subject || '(제목 없음)'}</span>
          </DialogTitle>
          <DialogDescription>
            발송된 1:1 메일의 상세 내용과 오픈 추적 정보입니다.
          </DialogDescription>
        </DialogHeader>

        {/* 메타 정보 그리드 */}
        <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm border rounded-lg p-4 bg-muted/30">
          <div className="text-muted-foreground">받는 사람</div>
          <div className="font-medium">
            {message.to_name ? `${message.to_name} <${message.to_email}>` : message.to_email}
          </div>

          {message.cc && message.cc.length > 0 && (
            <>
              <div className="text-muted-foreground">CC</div>
              <div>{message.cc.join(', ')}</div>
            </>
          )}

          {message.bcc && message.bcc.length > 0 && (
            <>
              <div className="text-muted-foreground">BCC</div>
              <div>{message.bcc.join(', ')}</div>
            </>
          )}

          <div className="text-muted-foreground">발송 시각</div>
          <div>{formatTs(message.sent_at)}</div>

          <div className="text-muted-foreground">상태</div>
          <div className={`inline-flex items-center gap-1 ${statusMeta.color}`}>
            <StatusIcon className="w-3.5 h-3.5" />
            {statusMeta.label}
            {message.error_message && (
              <span className="ml-2 text-xs text-red-500" title={message.error_message}>
                ({message.error_message.slice(0, 60)}{message.error_message.length > 60 ? '…' : ''})
              </span>
            )}
          </div>

          {/* 오픈 추적 */}
          <div className="text-muted-foreground">수신확인</div>
          <div>
            {message.opened ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <Eye className="w-3.5 h-3.5" />
                <span className="font-medium">열어봤어요</span>
                <Badge variant="secondary" className="ml-1">
                  {message.open_count}회
                </Badge>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <EyeOff className="w-3.5 h-3.5" />
                아직 열어보지 않음
              </span>
            )}
          </div>

          {message.opened && (
            <>
              <div className="text-muted-foreground">처음 오픈</div>
              <div>{formatTs(message.first_opened_at)}</div>
              <div className="text-muted-foreground">최근 오픈</div>
              <div>{formatTs(message.last_opened_at)}</div>
            </>
          )}

          {message.gmail_thread_id && (
            <>
              <div className="text-muted-foreground">Gmail Thread</div>
              <div className="font-mono text-xs text-muted-foreground truncate">
                {message.gmail_thread_id}
              </div>
            </>
          )}
        </div>

        {/* 본문 미리보기 */}
        <div className="space-y-2">
          <div className="text-sm font-medium">본문</div>
          <div className="border rounded-lg p-4 bg-white dark:bg-zinc-950 max-h-[400px] overflow-y-auto">
            {message.body_html ? (
              <div
                className="prose prose-sm max-w-none dark:prose-invert"
                // 본문은 자체 발송자가 만든 HTML — XSS 우려 없음 (자기 자신의 메일).
                // 트래킹 픽셀은 발송 직전에 주입된 거라 DB body_html 에는 없음.
                dangerouslySetInnerHTML={{ __html: message.body_html }}
              />
            ) : (
              <div className="text-sm text-muted-foreground italic">(본문 없음)</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
