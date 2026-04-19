import { useParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SignaturePreview } from '@/components/signatures/SignaturePreview'
import { CampaignAnalytics } from '@/components/campaigns/CampaignAnalytics'
import {
  useCampaign,
  useCampaignRecipients,
  useDeleteCampaign,
  useUpdateCampaign,
} from '@/hooks/useCampaigns'
import { useCampaignBlocks } from '@/hooks/useCampaignBlocks'
import { useSendCampaign } from '@/hooks/useSendCampaign'
import { useCampaignAttachments } from '@/hooks/useAttachments'
import { formatBytes } from '@/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ArrowLeft,
  Send,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Mail,
  Blocks,
  Copy,
  RotateCcw,
  Paperclip,
  Link as LinkIcon,
  ExternalLink,
  AlertTriangle,
  Pencil,
  CalendarClock,
  Ban,
  Eye,
  Reply,
  AlertCircle,
} from 'lucide-react'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { toast } from 'sonner'
import type { RecipientStatus } from '@/types/campaign'

const RECIPIENT_STATUS_META: Record<RecipientStatus, { label: string; color: string }> = {
  pending: { label: '대기', color: 'text-muted-foreground' },
  sending: { label: '발송 중', color: 'text-amber-600 dark:text-amber-400' },
  sent: { label: '성공', color: 'text-green-600 dark:text-green-400' },
  failed: { label: '실패', color: 'text-red-600 dark:text-red-400' },
  bounced: { label: '반송', color: 'text-orange-600 dark:text-orange-400' },
  skipped: { label: '건너뜀', color: 'text-muted-foreground' },
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: campaign, isLoading } = useCampaign(id)
  const { data: recipients = [] } = useCampaignRecipients(id)
  const { data: blocks = [] } = useCampaignBlocks(id)
  const { data: attachments = [] } = useCampaignAttachments(id)
  const sendCampaign = useSendCampaign()
  const deleteCampaign = useDeleteCampaign()
  const updateCampaign = useUpdateCampaign()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [cancelScheduleOpen, setCancelScheduleOpen] = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [rescheduleDraft, setRescheduleDraft] = useState<string>('')
  const [sendNowOpen, setSendNowOpen] = useState(false)

  if (isLoading || !campaign) {
    return (
      <div className="p-4 sm:p-6 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    )
  }

  const progress =
    campaign.total_count > 0
      ? Math.round(((campaign.sent_count + campaign.failed_count) / campaign.total_count) * 100)
      : 0
  const isSending = campaign.status === 'sending' || sendCampaign.isPending
  const isScheduled = campaign.status === 'scheduled'
  const canSend = campaign.status === 'draft' || campaign.status === 'failed'
  // 발송 이력이 있어야 "재사용" 의미가 있음 (draft 제외)
  const canReuse = campaign.status !== 'draft' && campaign.status !== 'scheduled'
  // 아직 발송되지 않은 캠페인만 편집 가능
  const canEdit = campaign.status === 'draft' || campaign.status === 'scheduled'

  // ----------------------------------------------------------------
  // 예약 제어 핸들러 — 낙관적으로 업데이트 후 invalidate
  // ----------------------------------------------------------------
  const invalidateAfterSchedule = () => {
    qc.invalidateQueries({ queryKey: ['campaigns'] })
    qc.invalidateQueries({ queryKey: ['campaigns', 'detail', id] })
  }

  const handleCancelSchedule = async () => {
    if (!id) return
    try {
      await updateCampaign.mutateAsync({
        id,
        data: { status: 'draft', scheduled_at: null },
      })
      invalidateAfterSchedule()
      setCancelScheduleOpen(false)
      toast.success('예약이 취소되어 초안으로 되돌아갔습니다.')
    } catch {
      // onError
    }
  }

  const handleReschedule = async () => {
    if (!id) return
    if (!rescheduleDraft) {
      toast.error('시각을 선택해주세요.')
      return
    }
    const newTime = new Date(rescheduleDraft).getTime()
    if (isNaN(newTime) || newTime < Date.now() + 60_000) {
      toast.error('예약 시각은 현재로부터 최소 1분 이후여야 합니다.')
      return
    }
    try {
      await updateCampaign.mutateAsync({
        id,
        data: {
          status: 'scheduled',
          scheduled_at: new Date(rescheduleDraft).toISOString(),
        },
      })
      invalidateAfterSchedule()
      setRescheduleOpen(false)
      toast.success('발송 시각이 변경되었습니다.')
    } catch {
      // onError
    }
  }

  const handleSendNow = async () => {
    if (!id) return
    try {
      // 예약 해제 후 즉시 발송 — status 를 먼저 draft 로 낮춘 뒤 sendCampaign 을 호출해야
      // useSendCampaign 의 로직이 정상 동작한다 (scheduled 상태에선 client-side send 미지원).
      await updateCampaign.mutateAsync({
        id,
        data: { status: 'draft', scheduled_at: null },
      })
      invalidateAfterSchedule()
      setSendNowOpen(false)
      await sendCampaign.mutateAsync({ campaignId: id })
    } catch {
      // onError
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => navigate('/campaigns')}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold truncate">{campaign.name}</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {format(new Date(campaign.created_at), 'yyyy년 M월 d일 HH:mm', { locale: ko })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {canSend && (
              <Button size="sm" onClick={() => setSendOpen(true)} disabled={isSending}>
                {isSending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    발송 중
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-1" />
                    발송하기
                  </>
                )}
              </Button>
            )}
            {isScheduled && (
              <>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setSendNowOpen(true)}
                  disabled={updateCampaign.isPending || sendCampaign.isPending}
                  title="예약을 해제하고 지금 바로 발송"
                >
                  <Send className="w-4 h-4 mr-1" />
                  지금 발송
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // datetime-local 초기값 = 현재 예약 시각 (없으면 30분 뒤)
                    const base = campaign.scheduled_at
                      ? new Date(campaign.scheduled_at)
                      : new Date(Date.now() + 30 * 60_000)
                    const pad = (n: number) => String(n).padStart(2, '0')
                    setRescheduleDraft(
                      `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`,
                    )
                    setRescheduleOpen(true)
                  }}
                  disabled={updateCampaign.isPending}
                >
                  <CalendarClock className="w-4 h-4 mr-1" />
                  시간 변경
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCancelScheduleOpen(true)}
                  disabled={updateCampaign.isPending}
                  className="text-amber-700 hover:text-amber-800 dark:text-amber-400"
                >
                  <Ban className="w-4 h-4 mr-1" />
                  예약 취소
                </Button>
              </>
            )}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/campaigns/new?edit=${id}`)}
                disabled={isSending}
              >
                <Pencil className="w-4 h-4 mr-1" />
                편집
              </Button>
            )}
            {canReuse && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isSending}>
                    <Copy className="w-4 h-4 mr-1" />
                    재사용
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={() => navigate(`/campaigns/new?from=${id}&mode=all`)}>
                    <Copy className="w-4 h-4 mr-2" />
                    전체 복제해서 편집
                  </DropdownMenuItem>
                  {campaign.failed_count > 0 && (
                    <DropdownMenuItem
                      onClick={() => navigate(`/campaigns/new?from=${id}&mode=failed`)}
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      실패한 {campaign.failed_count}명만 재발송
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              className="text-destructive"
              disabled={isSending}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {/* 예약 발송 안내 — status='scheduled' 일 때만 */}
        {isScheduled && campaign.scheduled_at && (
          <Card className="border-blue-300 bg-blue-50/60 dark:border-blue-900/60 dark:bg-blue-950/20">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <CalendarClock className="w-5 h-5 text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-blue-900 dark:text-blue-100">
                    예약 발송 대기 중
                  </div>
                  <div className="text-xs text-blue-800/80 dark:text-blue-200/80 mt-0.5">
                    {format(new Date(campaign.scheduled_at), 'yyyy년 M월 d일 (EEE) HH:mm', {
                      locale: ko,
                    })}
                    {' · '}
                    {formatRelative(campaign.scheduled_at)}
                  </div>
                  <div className="text-xs text-blue-800/70 dark:text-blue-200/70 mt-1">
                    예정된 시각이 되면 서버가 자동으로 발송합니다. 창을 닫아도 동작합니다.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 진행 상태 */}
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
              <Stat label="전체" value={campaign.total_count} icon={Mail} color="text-foreground" />
              <Stat
                label="성공"
                value={campaign.sent_count}
                icon={CheckCircle2}
                color="text-green-600 dark:text-green-400"
              />
              <Stat
                label="실패"
                value={campaign.failed_count}
                icon={XCircle}
                color="text-red-600 dark:text-red-400"
              />
              <Stat
                label="남음"
                value={campaign.total_count - campaign.sent_count - campaign.failed_count}
                icon={Clock}
                color="text-amber-600 dark:text-amber-400"
              />
            </div>
            {campaign.total_count > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">진행률</span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      campaign.status === 'sent'
                        ? 'bg-green-500'
                        : campaign.status === 'failed'
                          ? 'bg-red-500'
                          : 'bg-amber-500'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 분석 섹션 — recipients 가 0이면 내부에서 null 반환 */}
        <CampaignAnalytics
          recipients={recipients}
          enableOpenTracking={campaign.enable_open_tracking}
        />

        {/* 메일 내용 */}
        <Card>
          <CardContent className="p-4">
            <div className="mb-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label>제목</Label>
                {/* 발송 방식 배지 — 개별(individual) / 일괄(bulk) */}
                {campaign.send_mode === 'bulk' ? (
                  <Badge variant="default" className="text-[10px]">
                    <Send className="w-3 h-3 mr-0.5" />
                    한 번에 보내기
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    <Send className="w-3 h-3 mr-0.5" />
                    개별 발송
                  </Badge>
                )}
              </div>
              <p className="text-sm font-medium mt-0.5">{campaign.subject}</p>
            </div>
            {(Array.isArray(campaign.cc) && campaign.cc.length > 0) && (
              <div className="mb-2">
                <Label>참조 (Cc)</Label>
                <p className="text-xs mt-0.5 break-all">{campaign.cc.join(', ')}</p>
              </div>
            )}
            {(Array.isArray(campaign.bcc) && campaign.bcc.length > 0) && (
              <div className="mb-2">
                <Label>숨은참조 (Bcc)</Label>
                <p className="text-xs mt-0.5 break-all">{campaign.bcc.join(', ')}</p>
              </div>
            )}
            {blocks.length > 0 && (
              <div className="mb-3">
                <Label>
                  <span className="inline-flex items-center gap-1">
                    <Blocks className="w-3 h-3" /> 블록 구성 ({blocks.length})
                  </span>
                </Label>
                <div className="mt-1 space-y-1">
                  {blocks.map((b, i) => (
                    <div
                      key={b.id}
                      className="flex items-center gap-2 p-2 border rounded text-sm"
                    >
                      <Badge variant="secondary" className="shrink-0">
                        {i + 1}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{b.template.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {b.template.subject}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <Label>본문 미리보기</Label>
              <div className="mt-1 border rounded bg-white dark:bg-gray-950">
                <SignaturePreview html={campaign.body_html ?? ''} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 첨부 파일 */}
        {attachments.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center justify-between">
                <Label>
                  <span className="inline-flex items-center gap-1">
                    <Paperclip className="w-3 h-3" />
                    첨부 파일 ({attachments.length})
                  </span>
                </Label>
                {(() => {
                  // S12: 첫 attachment 만 보던 것을 전체 스캔으로 바꿈.
                  // 캠페인 단위로 delivery_mode 가 동일하게 설정되지만 혹시 섞여있거나
                  // (draft: null) 누락된 경우에도 올바른 배지를 보여주기 위해.
                  const modes = new Set(
                    attachments.map((a) => a.delivery_mode).filter(Boolean) as Array<
                      'attachment' | 'link'
                    >
                  )
                  if (modes.size === 0) return null
                  const mixed = modes.size > 1
                  const mode = mixed ? 'link' : (modes.values().next().value as 'attachment' | 'link')
                  return (
                    <Badge
                      variant={mode === 'link' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {mode === 'link' ? (
                        <>
                          <LinkIcon className="w-3 h-3 mr-0.5" />
                          {mixed ? 'Drive 링크 (혼합)' : 'Drive 링크 전송'}
                        </>
                      ) : (
                        <>
                          <Paperclip className="w-3 h-3 mr-0.5" />
                          메일 첨부 전송
                        </>
                      )}
                    </Badge>
                  )
                })()}
              </div>
              <div className="space-y-1">
                {attachments.map((a) => {
                  const deleted = !!a.deleted_from_drive_at
                  return (
                    <div
                      key={a.id}
                      className={`flex items-center gap-2 p-2 border rounded text-sm ${
                        deleted ? 'border-destructive/60' : ''
                      }`}
                    >
                      <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{a.file_name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <span>{formatBytes(a.file_size)}</span>
                          {deleted && (
                            <span className="text-destructive flex items-center gap-0.5">
                              <AlertTriangle className="w-3 h-3" />
                              Drive 에서 삭제됨
                            </span>
                          )}
                        </div>
                      </div>
                      {a.web_view_link && (
                        <a
                          href={a.web_view_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 수신자 목록 */}
        <Card>
          <CardContent className="p-0">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">수신자 ({recipients.length})</div>
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              {recipients.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  수신자가 없습니다.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground bg-muted/30 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">이메일</th>
                      <th className="text-left px-4 py-2 font-medium">이름</th>
                      <th className="text-left px-4 py-2 font-medium">상태</th>
                      <th className="text-left px-4 py-2 font-medium">활동</th>
                      <th className="text-left px-4 py-2 font-medium">발송 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => {
                      const meta =
                        RECIPIENT_STATUS_META[r.status as RecipientStatus] ??
                        RECIPIENT_STATUS_META.pending
                      // 반송된 수신자는 analytics 의 오픈률 분자 (status='sent') 에서 제외됨.
                      // 테이블도 같은 규칙을 따라 bounced 이면 opened/replied 배지를 숨겨
                      // 대시보드/테이블 집계 불일치를 없앤다. (일부 메일 서버가
                      // 반송 전 프리페치로 픽셀을 건드려 오픈 플래그가 켜지는 경우 있음)
                      const showOpened = r.opened && !r.bounced
                      const showReplied = r.replied && !r.bounced
                      const hasActivity = showOpened || showReplied || r.bounced
                      return (
                        <tr key={r.id} className="border-t">
                          <td className="px-4 py-2 truncate max-w-[240px]">{r.email}</td>
                          <td className="px-4 py-2 text-muted-foreground">{r.name ?? '-'}</td>
                          <td className={`px-4 py-2 ${meta.color}`}>
                            <div className="flex items-center gap-1.5">
                              {r.status === 'sending' && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              {meta.label}
                              {r.error_message && (
                                <span className="text-xs text-red-500" title={r.error_message}>
                                  ⚠
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2">
                            {hasActivity ? (
                              <div className="flex items-center gap-2">
                                {showOpened && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[11px] text-blue-600 dark:text-blue-400"
                                    title={
                                      (r.first_opened_at
                                        ? `최초 오픈: ${format(new Date(r.first_opened_at), 'M월 d일 HH:mm', { locale: ko })}`
                                        : '오픈됨') +
                                      (r.open_count > 1 ? ` · 총 ${r.open_count}회` : '')
                                    }
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    {r.open_count > 1 ? (
                                      <span className="font-medium">{r.open_count}</span>
                                    ) : null}
                                  </span>
                                )}
                                {showReplied && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[11px] text-green-600 dark:text-green-400"
                                    title={
                                      r.replied_at
                                        ? `답장: ${format(new Date(r.replied_at), 'M월 d일 HH:mm', { locale: ko })}`
                                        : '답장 수신'
                                    }
                                  >
                                    <Reply className="w-3.5 h-3.5" />
                                  </span>
                                )}
                                {r.bounced && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[11px] text-orange-600 dark:text-orange-400"
                                    title={r.bounce_reason ?? '반송'}
                                  >
                                    <AlertCircle className="w-3.5 h-3.5" />
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {r.sent_at
                              ? format(new Date(r.sent_at), 'M월 d일 HH:mm:ss', { locale: ko })
                              : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="메일 발송 시작"
        description={`${campaign.total_count}명에게 메일을 발송합니다. 발송 후에는 취소할 수 없습니다.`}
        confirmLabel="발송 시작"
        loading={sendCampaign.isPending}
        onConfirm={async () => {
          if (!id) return
          try {
            await sendCampaign.mutateAsync({ campaignId: id })
            setSendOpen(false)
          } catch {
            // onError 에서 토스트
          }
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="메일 발송 삭제"
        description="메일 발송과 수신자 내역이 모두 삭제됩니다."
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteCampaign.isPending}
        onConfirm={async () => {
          if (!id) return
          try {
            await deleteCampaign.mutateAsync(id)
            navigate('/campaigns')
          } catch {
            // onError
          }
        }}
      />

      <ConfirmDialog
        open={cancelScheduleOpen}
        onOpenChange={setCancelScheduleOpen}
        title="예약 발송 취소"
        description="예약을 취소하면 초안 상태로 되돌아갑니다. 작성한 내용은 유지되며, 나중에 다시 예약할 수 있습니다."
        confirmLabel="예약 취소"
        loading={updateCampaign.isPending}
        onConfirm={handleCancelSchedule}
      />

      <ConfirmDialog
        open={sendNowOpen}
        onOpenChange={setSendNowOpen}
        title="예약 해제 후 지금 발송"
        description={`${campaign.total_count}명에게 지금 바로 메일을 발송합니다. 발송 후에는 취소할 수 없습니다.`}
        confirmLabel="지금 발송 시작"
        loading={updateCampaign.isPending || sendCampaign.isPending}
        onConfirm={handleSendNow}
      />

      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>발송 시각 변경</DialogTitle>
            <DialogDescription>
              새 발송 시각을 선택해주세요. 현재로부터 최소 1분 이후여야 합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Input
              type="datetime-local"
              value={rescheduleDraft}
              onChange={(e) => setRescheduleDraft(e.target.value)}
            />
            {rescheduleDraft && !isNaN(new Date(rescheduleDraft).getTime()) && (
              <p className="text-xs text-muted-foreground">
                {new Date(rescheduleDraft).toLocaleString('ko-KR', {
                  weekday: 'short',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleOpen(false)}>
              취소
            </Button>
            <Button onClick={handleReschedule} disabled={updateCampaign.isPending}>
              {updateCampaign.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  저장 중
                </>
              ) : (
                <>
                  <CalendarClock className="w-4 h-4 mr-1" />
                  변경
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// "5분 뒤", "3시간 뒤", "2일 뒤" 같이 상대 시간 표시
function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return '곧'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}분 뒤`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}시간 뒤`
  const day = Math.round(hr / 24)
  return `${day}일 뒤`
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground">{children}</div>
}

function Stat({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string
  value: number
  icon: typeof Mail
  color: string
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className={`text-2xl font-bold flex items-center gap-1.5 ${color}`}>
        <Icon className="w-5 h-5" />
        {value}
      </div>
    </div>
  )
}
