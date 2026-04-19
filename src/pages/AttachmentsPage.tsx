// 첨부 파일 이력 페이지
//
// - 사용자가 업로드/픽 한 모든 Drive 첨부의 통계 + 누구에게 갔는지 drilldown
// - attachment_send_stats 뷰 기반 (총 발송 수, 유니크 수신자, 마지막 발송 시각)

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useAttachmentSendStats,
  useAttachmentRecipients,
} from '@/hooks/useAttachments'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/utils'
import {
  Paperclip,
  Search,
  ExternalLink,
  AlertTriangle,
  Users,
  Send,
  Mail,
  Link as LinkIcon,
  ArrowUpDown,
} from 'lucide-react'

type SortKey = 'last_sent_at' | 'total_sends' | 'file_name' | 'file_size'

export default function AttachmentsPage() {
  const { data: stats = [], isLoading } = useAttachmentSendStats()
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('last_sent_at')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = stats
    .filter(
      (s) =>
        !query.trim() ||
        (s.file_name ?? '').toLowerCase().includes(query.trim().toLowerCase())
    )
    .sort((a, b) => {
      switch (sortKey) {
        case 'file_name':
          return (a.file_name ?? '').localeCompare(b.file_name ?? '')
        case 'file_size':
          return (b.file_size ?? 0) - (a.file_size ?? 0)
        case 'total_sends':
          return (b.total_sends ?? 0) - (a.total_sends ?? 0)
        case 'last_sent_at':
        default: {
          const av = a.last_sent_at ? new Date(a.last_sent_at).getTime() : 0
          const bv = b.last_sent_at ? new Date(b.last_sent_at).getTime() : 0
          return bv - av
        }
      }
    })

  const selected = selectedId ? stats.find((s) => s.attachment_id === selectedId) ?? null : null

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Paperclip className="w-5 h-5" />
          첨부 파일
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          업로드한 파일과 발송 이력을 확인합니다.
        </p>
      </div>

      <div className="px-6 py-3 border-b flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="파일 이름 검색..."
            className="pl-8 h-9"
          />
        </div>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="w-[180px] h-9">
            <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_sent_at">최근 발송 순</SelectItem>
            <SelectItem value="total_sends">발송 많은 순</SelectItem>
            <SelectItem value="file_name">이름 순</SelectItem>
            <SelectItem value="file_size">크기 큰 순</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            title={query ? '검색 결과가 없습니다' : '첨부 파일이 없습니다'}
            description={
              query
                ? '다른 키워드로 검색해보세요.'
                : '템플릿이나 메일 발송에 파일을 추가하면 이곳에 표시됩니다.'
            }
          />
        ) : (
          <div className="p-6 space-y-2">
            {filtered.map((s) => {
              const deleted = !!s.deleted_from_drive_at
              return (
                <Card
                  key={s.attachment_id ?? ''}
                  className={`cursor-pointer transition-colors hover:bg-accent ${
                    deleted ? 'border-destructive/40' : ''
                  }`}
                  onClick={() => setSelectedId(s.attachment_id ?? null)}
                >
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center shrink-0">
                      <Paperclip className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate flex items-center gap-1.5">
                        {s.file_name}
                        {deleted && (
                          <Badge variant="destructive" className="text-[10px] h-4 px-1">
                            <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
                            삭제됨
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                        <span>{formatBytes(s.file_size)}</span>
                        <span>·</span>
                        <span>{s.mime_type ?? 'unknown'}</span>
                        {s.last_sent_at && (
                          <>
                            <span>·</span>
                            <span>{formatRelative(s.last_sent_at)} 발송</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-xs">
                      <Stat
                        icon={<Send className="w-3 h-3" />}
                        value={s.total_sends ?? 0}
                        label="발송"
                      />
                      <Stat
                        icon={<Users className="w-3 h-3" />}
                        value={s.unique_recipients ?? 0}
                        label="수신자"
                      />
                      <Stat
                        icon={<Mail className="w-3 h-3" />}
                        value={s.unique_campaigns ?? 0}
                        label="메일 발송"
                      />
                    </div>
                    {s.web_view_link && (
                      <a
                        href={s.web_view_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <AttachmentDetailSheet
        attachmentId={selectedId}
        summary={selected}
        onClose={() => setSelectedId(null)}
      />
    </div>
  )
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: number
  label: string
}) {
  return (
    <div className="flex flex-col items-center min-w-[42px]">
      <div className="flex items-center gap-0.5 font-semibold text-sm text-foreground">
        {icon}
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  )
}

// ------------------------------------------------------------
// Drilldown — 파일이 누구에게 발송됐는지
// ------------------------------------------------------------

type SummaryType = {
  attachment_id: string | null
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  web_view_link: string | null
  total_sends: number | null
  unique_recipients: number | null
  unique_campaigns: number | null
  last_sent_at: string | null
} | null

function AttachmentDetailSheet({
  attachmentId,
  summary,
  onClose,
}: {
  attachmentId: string | null
  summary: SummaryType
  onClose: () => void
}) {
  const { data: rows = [], isLoading } = useAttachmentRecipients(attachmentId ?? undefined)

  return (
    <Sheet open={!!attachmentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Paperclip className="w-4 h-4" />
            {summary?.file_name ?? '첨부 파일'}
          </SheetTitle>
          <SheetDescription>
            이 파일이 발송된 이력을 확인합니다.
          </SheetDescription>
        </SheetHeader>

        {summary && (
          <Card className="mt-4">
            <CardContent className="p-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-xs text-muted-foreground">총 발송</div>
                <div className="text-lg font-bold">{summary.total_sends ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">수신자</div>
                <div className="text-lg font-bold">{summary.unique_recipients ?? 0}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">메일 발송</div>
                <div className="text-lg font-bold">{summary.unique_campaigns ?? 0}</div>
              </div>
            </CardContent>
          </Card>
        )}

        {summary?.web_view_link && (
          <Button
            variant="outline"
            size="sm"
            className="w-full mt-3"
            asChild
          >
            <a href={summary.web_view_link} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-3.5 h-3.5 mr-1" />
              Google Drive 에서 열기
            </a>
          </Button>
        )}

        <div className="mt-4">
          <div className="text-xs text-muted-foreground mb-2">발송 이력</div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              아직 발송된 적이 없습니다.
            </div>
          ) : (
            <div className="space-y-1">
              {rows.map((r) => (
                <div
                  key={r.id as string}
                  className="flex items-center gap-2 p-2 border rounded text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {(r.recipient_name as string | null) ?? (r.recipient_email as string)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.recipient_email as string}
                      {r.campaign_name && (
                        <span className="ml-1">· {r.campaign_name as string}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <Badge
                      variant={
                        (r.delivery_mode as string) === 'link' ? 'default' : 'secondary'
                      }
                      className="text-[10px] h-4 px-1"
                    >
                      {(r.delivery_mode as string) === 'link' ? (
                        <>
                          <LinkIcon className="w-2.5 h-2.5 mr-0.5" />
                          링크
                        </>
                      ) : (
                        <>
                          <Paperclip className="w-2.5 h-2.5 mr-0.5" />
                          첨부
                        </>
                      )}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDateTime(r.sent_at as string)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
