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
  useAddRecipientToCampaign,
  useRemoveRecipientFromCampaign,
} from '@/hooks/useCampaigns'
import { useContacts } from '@/hooks/useContacts'
import { ThreadComposeDialog } from '@/components/campaigns/ThreadComposeDialog'
import { ThreadMessagesSection } from '@/components/campaigns/ThreadMessagesSection'
import type { ThreadMode } from '@/hooks/useSendThreadMessage'
import { useSignatureById } from '@/hooks/useSignatures'
import { useProfile } from '@/hooks/useProfile'
import { replyCategoryOption, type ReplyCategory } from '@/types/replyCategory'
import { useBackfillReplyCategories } from '@/hooks/useBackfillReplyCategories'
import { matchesSearch } from '@/lib/search'
import { Search, X, UserPlus } from 'lucide-react'
import { useCampaignBlocks } from '@/hooks/useCampaignBlocks'
import { useSendCampaign } from '@/hooks/useSendCampaign'
import { useCampaignAttachments } from '@/hooks/useAttachments'
import { useContactById, useToggleUnsubscribe, useContactsTitleMap } from '@/hooks/useContacts'
import { ContactDetailSheet } from '@/components/contacts/ContactDetailSheet'
import { ContactFormDialog } from '@/components/contacts/ContactFormDialog'
import type { ContactWithGroups } from '@/types/contact'
import { formatBytes } from '@/lib/utils'
import { renderTemplate, bodyAlreadyContainsSignature } from '@/lib/mailMerge'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
  ReplyAll,
  Forward,
  MoreHorizontal,
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
  // 미리보기에서 서명을 동적으로 append — body_html 에 이미 포함돼 있지 않을 때만.
  // (편집 모드에서 서명만 바꿨는데 body_html 이 갱신되지 않은 케이스 방어)
  const { data: signature } = useSignatureById(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (campaign as any)?.signature_id ?? null
  )
  const { data: profile } = useProfile()

  // 미리보기 수신자 선택 — 사용자가 어느 수신자 기준으로 변수 치환 결과를 볼지.
  // 기본: 첫 번째 수신자. 변경 가능 (수신자 N명 캠페인에서 다른 수신자 결과도 확인).
  const [previewRecipientId, setPreviewRecipientId] = useState<string | null>(null)
  const previewRecipient = useMemo(() => {
    if (recipients.length === 0) return null
    const target = previewRecipientId
      ? recipients.find((r) => r.id === previewRecipientId)
      : null
    return target ?? recipients[0]
  }, [recipients, previewRecipientId])

  // 변수 치환 — 미리보기 수신자의 variables 로 {{name}} 등 머지.
  // recipients[0] 이 없는 경우 (draft 발송 전 일부 상태) 는 raw body 그대로.
  const previewSubject = useMemo(() => {
    const subj = campaign?.subject ?? ''
    if (!previewRecipient || !subj) return subj
    return renderTemplate(
      subj,
      (previewRecipient.variables ?? {}) as Record<string, string | null>,
    )
  }, [campaign?.subject, previewRecipient])

  const previewBodyHtml = useMemo(() => {
    // 발송 경로 (useSendCampaign) 와 동일 순서로 합성 — 미리보기/실제 불일치 방지.
    //   ① 본문 + (이미 포함 안 됐으면) 시그니처 append  ② 그 후 전체 변수 치환
    // 이렇게 해야 (a) 시그니처 내 {{변수}} 도 치환되고 (b) fuzzy 매칭으로 시그니처 중복 안 됨.
    let finalBody = campaign?.body_html ?? ''
    const sigHtml = signature?.html ?? ''
    if (sigHtml && !bodyAlreadyContainsSignature(finalBody, sigHtml)) {
      finalBody = finalBody ? `${finalBody}<br/><br/>${sigHtml}` : sigHtml
    }
    if (previewRecipient && finalBody) {
      finalBody = renderTemplate(
        finalBody,
        (previewRecipient.variables ?? {}) as Record<string, string | null>,
      )
    }
    return finalBody
  }, [campaign?.body_html, signature?.html, previewRecipient])

  // 답장이 있지만 reply_category 가 NULL 인 행 — 028 마이그레이션 이전 답장 또는
  // 분류 시점 예산 부족으로 누락된 케이스. "이전 답장 분류" 버튼이 이 수를 보고 표시.
  const unclassifiedReplyCount = useMemo(() => {
    return recipients.filter((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ext = r as any as { reply_category?: ReplyCategory | null }
      return r.replied && ext.reply_category == null
    }).length
  }, [recipients])
  const backfill = useBackfillReplyCategories()
  const sendCampaign = useSendCampaign()
  const deleteCampaign = useDeleteCampaign()
  const updateCampaign = useUpdateCampaign()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [cancelScheduleOpen, setCancelScheduleOpen] = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [rescheduleDraft, setRescheduleDraft] = useState<string>('')
  const [sendNowOpen, setSendNowOpen] = useState(false)
  // 팔로업 / 회신 / 전달 다이얼로그 — 발송된 수신자 행에서 액션 클릭 시 열림.
  const [threadCompose, setThreadCompose] = useState<{
    mode: ThreadMode
    recipient: {
      contactId?: string | null
      recipientId?: string | null
      campaignId?: string | null
      email: string
      name?: string | null
    }
    original: {
      gmailMessageId: string | null
      gmailThreadId: string | null
      subject: string | null
      bodyHtml?: string | null
      fromLabel?: string | null
      sentAt?: string | null
    }
  } | null>(null)
  // 수신자 이메일 클릭 시 ContactDetailSheet 인라인 오픈 — 캠페인 페이지를 떠나지 않고
  // 사용 직책/그룹사/메모 등을 즉시 수정할 수 있게 한다.
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [editContact, setEditContact] = useState<ContactWithGroups | null>(null)
  const [editFormOpen, setEditFormOpen] = useState(false)
  const { data: openContact = null } = useContactById(openContactId)
  const toggleUnsub = useToggleUnsubscribe()

  // 수신자 추가/제거 (발송 전 캠페인에서만 활성화)
  const addRecipient = useAddRecipientToCampaign()
  const removeRecipient = useRemoveRecipientFromCampaign()
  const [recipientSearch, setRecipientSearch] = useState('')
  // 추가 검색용 — 전체 조직 연락처 풀에서 매칭
  const { data: allContacts = [] } = useContacts({ status: 'all' })
  const existingEmailSet = useMemo(
    () => new Set(recipients.map((r) => r.email.trim().toLowerCase())),
    [recipients]
  )
  const recipientSearchResults = useMemo(() => {
    const q = recipientSearch.trim()
    if (!q) return []
    return allContacts
      .filter((c) => {
        if (c.is_unsubscribed || c.is_bounced) return false
        if (!c.email) return false
        if (existingEmailSet.has(c.email.trim().toLowerCase())) return false
        return (
          matchesSearch(c.name, q) ||
          matchesSearch(c.email, q) ||
          matchesSearch(c.company, q) ||
          matchesSearch(c.company_ko, q) ||
          matchesSearch(c.department, q) ||
          matchesSearch(c.job_title, q)
        )
      })
      .slice(0, 20)
  }, [allContacts, recipientSearch, existingEmailSet])

  // 수신자 직책 컬럼을 LIVE 한 contact 데이터로 표시.
  // recipients.variables.job_title 은 캠페인 생성 시점 스냅샷이라 사용자가 그 사이
  // 사용 직책 (display_title) 을 수정하면 stale 해짐. 별도 batch 조회로 최신값 적용.
  const recipientContactIds = useMemo(
    () =>
      Array.from(
        new Set(
          recipients
            .map((r) => r.contact_id)
            .filter((v): v is string => typeof v === 'string' && v.length > 0)
        )
      ),
    [recipients]
  )
  const { data: liveTitleMap } = useContactsTitleMap(recipientContactIds)

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

        {/* 진행 상태 — 1:1 발송 (total_count===1) 에선 마케팅 메트릭 의미 없으므로 숨김.
            대신 1:1 모드에서는 ThreadMessagesSection 의 발송된 메시지와 회신/오픈 추적이
            훨씬 actionable. */}
        {campaign.total_count > 1 && (
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
        )}

        {/* 분석 섹션 — 1:1 (total_count===1) 에선 비율/통계 의미 없어 숨김. */}
        {campaign.total_count > 1 && (
          <CampaignAnalytics
            recipients={recipients}
            enableOpenTracking={campaign.enable_open_tracking}
          />
        )}

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
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <Label>본문 미리보기</Label>
                {/* 수신자 선택 — 변수 치환 결과를 다른 수신자 기준으로도 확인 가능.
                    1명이면 dropdown 숨김. 2+ 명이면 select 노출. */}
                {recipients.length > 1 && previewRecipient && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>수신자 기준:</span>
                    <Select
                      value={previewRecipient.id}
                      onValueChange={setPreviewRecipientId}
                    >
                      <SelectTrigger className="h-7 w-48 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {recipients.slice(0, 30).map((r) => (
                          <SelectItem key={r.id} value={r.id} className="text-xs">
                            {r.name || r.email}
                          </SelectItem>
                        ))}
                        {recipients.length > 30 && (
                          <div className="text-xs text-muted-foreground px-2 py-1">
                            …외 {recipients.length - 30}명
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {/* 제목 — 변수 치환된 형태 */}
              {campaign.subject && (
                <div className="mb-2 px-3 py-2 border rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground mb-0.5">제목</div>
                  <div className="text-sm font-medium">{previewSubject}</div>
                </div>
              )}
              <div className="border rounded bg-white dark:bg-gray-950">
                <SignaturePreview html={previewBodyHtml} />
              </div>
              {previewRecipient && (
                <div className="text-xs text-muted-foreground mt-1.5">
                  {previewRecipient.name || previewRecipient.email} 님이 받게 될 메일 모습
                </div>
              )}
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
            <div className="px-4 py-3 border-b space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">수신자 ({recipients.length})</div>
                {/* 이전 답장 백필 — NULL reply_category 행만 토대로 LLM 분류 */}
                {unclassifiedReplyCount > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={async () => {
                      try {
                        const r = await backfill.mutateAsync({
                          campaignId: id!,
                          limit: 200,
                        })
                        toast.success(
                          `답장 ${r.classified}건 분류 완료${r.remaining > 0 ? ` (남은 ${r.remaining}건은 다시 클릭)` : ''}`
                        )
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : '백필 실패')
                      }
                    }}
                    disabled={backfill.isPending}
                    title="이전에 도착한 답장도 톤 분류 (관심·질문·거절·부재중)"
                  >
                    {backfill.isPending ? (
                      <><Loader2 className="w-3 h-3 mr-1 animate-spin" />분류 중…</>
                    ) : (
                      <>이전 답장 {unclassifiedReplyCount}건 분류</>
                    )}
                  </Button>
                )}
              </div>
              {/* 발송 전 캠페인에서만 인라인 추가 — sent/sending 캠페인은 변경 불가 */}
              {canEdit && (
                <div className="space-y-1.5">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      className="pl-8 h-8 text-sm"
                      placeholder="이름/이메일/회사/부서/직책 검색해서 수신자 추가 (초성 가능)"
                      value={recipientSearch}
                      onChange={(e) => setRecipientSearch(e.target.value)}
                    />
                  </div>
                  {recipientSearch.trim() && (
                    <div className="border rounded-lg bg-popover shadow-sm divide-y max-h-56 overflow-y-auto">
                      {recipientSearchResults.length === 0 ? (
                        <div className="p-3 text-xs text-muted-foreground text-center">
                          매칭되는 연락처가 없거나 이미 모두 수신자입니다.
                        </div>
                      ) : (
                        recipientSearchResults.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            disabled={addRecipient.isPending}
                            onClick={() => {
                              addRecipient.mutate(
                                {
                                  campaignId: id!,
                                  contact: {
                                    id: c.id,
                                    email: c.email,
                                    name: c.name,
                                    company: c.company,
                                    department: c.department,
                                    job_title: c.job_title,
                                    display_title: c.display_title,
                                  },
                                },
                                { onSuccess: () => setRecipientSearch('') }
                              )
                            }}
                            className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent transition-colors disabled:opacity-50"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">
                                {c.name ?? c.email}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {c.email}
                                {c.company ? ` · ${c.company}` : ''}
                                {c.job_title ? ` · ${c.job_title}` : ''}
                              </p>
                            </div>
                            <UserPlus className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-2" />
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
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
                      <th className="text-left px-4 py-2 font-medium">직책</th>
                      <th className="text-left px-4 py-2 font-medium">상태</th>
                      <th className="text-left px-4 py-2 font-medium">활동</th>
                      <th className="text-left px-4 py-2 font-medium">발송 시각</th>
                      {/* 액션 컬럼 — 편집 가능 (X 버튼) 이거나 발송된 캠페인 (팔로업/회신/전달 메뉴) 일 때 노출. */}
                      <th className="w-10 px-2" />
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
                      // 직책 컬럼: LIVE contact 의 사용 직책(display_title || job_title) 우선,
                      // contact 가 없거나 (deleted) 비어 있으면 캠페인 스냅샷 사용.
                      const vars = (r.variables ?? {}) as Record<string, string | undefined>
                      const snapshotTitle = vars.job_title?.trim() || ''
                      const liveTitle = r.contact_id ? liveTitleMap?.get(r.contact_id) : undefined
                      const displayTitle = liveTitle || snapshotTitle
                      // 스냅샷과 live 가 다르면 mail 발송 시 어떤 값이 쓰일지 안내 (편집 → 저장 시 갱신됨)
                      const titleStale =
                        liveTitle !== undefined &&
                        snapshotTitle !== '' &&
                        liveTitle !== snapshotTitle
                      return (
                        <tr key={r.id} className="border-t">
                          <td className="px-4 py-2 truncate max-w-[240px]">
                            {r.contact_id ? (
                              <button
                                type="button"
                                onClick={() => setOpenContactId(r.contact_id as string)}
                                className="text-left hover:text-primary hover:underline transition-colors"
                                title="클릭하면 연락처 상세 패널이 열립니다 — 사용 직책/그룹사 등을 즉시 수정 가능"
                              >
                                {r.email}
                              </button>
                            ) : (
                              // contact_id 가 NULL = 원본 연락처가 삭제된 상태. 클릭 비활성.
                              <span className="text-muted-foreground" title="원본 연락처가 삭제되어 편집할 수 없습니다.">
                                {r.email}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">{r.name ?? '-'}</td>
                          <td
                            className="px-4 py-2 text-muted-foreground truncate max-w-[180px]"
                            title={
                              titleStale
                                ? `최신값: ${liveTitle}\n발송 예정값(스냅샷): ${snapshotTitle}\n→ 편집 → 저장하면 최신값으로 갱신됨`
                                : vars.job_title_raw && vars.job_title_raw !== displayTitle
                                ? `원본: ${vars.job_title_raw}`
                                : undefined
                            }
                          >
                            <span className="inline-flex items-center gap-1">
                              {displayTitle || '-'}
                              {titleStale && (
                                <span
                                  className="text-amber-500 text-xs"
                                  aria-label="스냅샷과 다름"
                                >
                                  ⚠
                                </span>
                              )}
                            </span>
                          </td>
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
                                {showReplied && (() => {
                                  // generated types 가 아직 reply_category / gmail_thread_id /
                                  // last_thread_message_from_me 를 포함 안 해서 cast.
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  const rExt = r as any as {
                                    reply_category?: ReplyCategory | null
                                    gmail_thread_id?: string | null
                                    last_thread_message_from_me?: boolean | null
                                  }
                                  const catOpt = replyCategoryOption(rExt.reply_category ?? null)
                                  // null = cron pass2 미반영 — 보수적으로 '대기' 로 간주.
                                  const awaitingMe =
                                    rExt.last_thread_message_from_me !== true
                                  const replyHref = rExt.gmail_thread_id
                                    ? `https://mail.google.com/mail/u/0/#all/${rExt.gmail_thread_id}`
                                    : null
                                  const replyTitle = r.replied_at
                                    ? `답장: ${format(new Date(r.replied_at), 'M월 d일 HH:mm', { locale: ko })}${catOpt ? ` · ${catOpt.label}` : ''}`
                                    : '답장 수신'
                                  return (
                                    <span className="inline-flex items-center gap-1">
                                      {replyHref ? (
                                        <a
                                          href={replyHref}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="inline-flex items-center text-[11px] text-green-600 dark:text-green-400 hover:underline"
                                          title={`${replyTitle} — Gmail 새 탭`}
                                        >
                                          <Reply className="w-3.5 h-3.5" />
                                        </a>
                                      ) : (
                                        <span
                                          className="inline-flex items-center text-[11px] text-green-600 dark:text-green-400"
                                          title={replyTitle}
                                        >
                                          <Reply className="w-3.5 h-3.5" />
                                        </span>
                                      )}
                                      {catOpt && (
                                        <span
                                          className={`inline-flex items-center text-[10px] px-1 py-0 h-4 rounded border ${catOpt.className}`}
                                          title={catOpt.hint}
                                        >
                                          {catOpt.label}
                                        </span>
                                      )}
                                      {awaitingMe && (
                                        <span
                                          className="inline-flex items-center text-[10px] px-1 py-0 h-4 rounded border bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border-rose-200 dark:border-rose-800"
                                          title="고객이 답장했는데 내가 아직 답장 안 함"
                                        >
                                          내 답장 대기
                                        </span>
                                      )}
                                    </span>
                                  )
                                })()}
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
                          <td className="w-10 px-2 text-right">
                            {/* pending 상태 제거 — draft/scheduled 캠페인에서만 가능 */}
                            {canEdit && r.status === 'pending' && (
                              <button
                                type="button"
                                disabled={removeRecipient.isPending}
                                onClick={() =>
                                  removeRecipient.mutate({
                                    recipientId: r.id,
                                    campaignId: id!,
                                  })
                                }
                                className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded hover:bg-destructive/10 disabled:opacity-50"
                                aria-label={`${r.email} 수신자 제외`}
                                title="수신자에서 제외"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                              {/* 발송 시도가 있던 수신자 — 팔로업/회신/전달 액션 메뉴.
                                  sent 외에 bounced/failed 에서도 "전달" 만큼은 의미가 있으므로
                                  메뉴는 노출하고 항목별로 개별 disable 처리한다. */}
                              {(r.status === 'sent' || r.status === 'bounced' || r.status === 'failed') && (() => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const rExt = r as any as {
                                  gmail_thread_id?: string | null
                                  gmail_message_id?: string | null
                                  replied?: boolean
                                  contact_id?: string | null
                                }
                                const canFollowup = r.status === 'sent'
                                const canReply = r.status === 'sent' && rExt.replied === true
                                const canForward = !!rExt.gmail_message_id // 원본 메시지 존재해야 전달 가능
                                const openMode = (mode: ThreadMode) => {
                                  setThreadCompose({
                                    mode,
                                    recipient: {
                                      contactId: rExt.contact_id ?? null,
                                      recipientId: r.id,
                                      campaignId: id!,
                                      email: r.email,
                                      name: r.name,
                                    },
                                    original: {
                                      gmailMessageId: rExt.gmail_message_id ?? null,
                                      gmailThreadId: rExt.gmail_thread_id ?? null,
                                      // 제목/본문 모두 수신자별 변수 머지 — 실제로 발송된 모습을 인용 블록에 보여주기 위해.
                                      // (캠페인 row 자체는 {{name}} 같은 placeholder 가 남아 있음)
                                      subject: campaign?.subject
                                        ? renderTemplate(campaign.subject, (r.variables ?? {}) as Record<string, string | null>)
                                        : null,
                                      bodyHtml: campaign?.body_html
                                        ? renderTemplate(campaign.body_html, (r.variables ?? {}) as Record<string, string | null>)
                                        : null,
                                      fromLabel: `${profile?.default_sender_name ?? profile?.display_name ?? ''} <${profile?.email ?? ''}>`,
                                      sentAt: r.sent_at,
                                    },
                                  })
                                }
                                return (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        type="button"
                                        className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded hover:bg-accent border border-transparent hover:border-border"
                                        title="이 수신자에게 액션 (팔로업/회신/전달)"
                                        aria-label="액션 메뉴 열기"
                                      >
                                        <MoreHorizontal className="w-4 h-4" />
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onClick={() => openMode('followup')}
                                        disabled={!canFollowup}
                                      >
                                        <Reply className="w-3.5 h-3.5 mr-2" />
                                        팔로업 (같은 thread)
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() => openMode('reply')}
                                        disabled={!canReply}
                                      >
                                        <ReplyAll className="w-3.5 h-3.5 mr-2" />
                                        답장에 회신
                                        {!canReply && <span className="ml-auto text-xs text-muted-foreground">회신 없음</span>}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() => openMode('forward')}
                                        disabled={!canForward}
                                      >
                                        <Forward className="w-3.5 h-3.5 mr-2" />
                                        다른 사람에게 전달
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )
                              })()}
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

        {/* 팔로업/회신/전달 기록 — thread_messages 가 있을 때만 렌더링 (내부에서 빈 상태 분기) */}
        {id && <ThreadMessagesSection campaignId={id} />}
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

      {/* 수신자 행 이메일 클릭 → 연락처 상세 패널 (인라인 편집) */}
      <ContactDetailSheet
        contact={openContact}
        open={!!openContactId}
        onOpenChange={(v) => {
          if (!v) setOpenContactId(null)
        }}
        onEdit={(c) => {
          setEditContact(c)
          setEditFormOpen(true)
          setOpenContactId(null)
        }}
        onToggleUnsubscribe={(c) =>
          toggleUnsub.mutate({ id: c.id, unsubscribe: !c.is_unsubscribed })
        }
      />
      <ContactFormDialog
        open={editFormOpen}
        onOpenChange={(v) => {
          setEditFormOpen(v)
          if (!v) setEditContact(null)
        }}
        contact={editContact}
      />
      {threadCompose && (
        <ThreadComposeDialog
          // key 로 recipient+mode 조합 → 다른 수신자/모드로 다시 열 때 강제 remount (8차 fix 일관성)
          key={`${threadCompose.mode}-${threadCompose.recipient.recipientId ?? threadCompose.recipient.email}`}
          open={!!threadCompose}
          onOpenChange={(v) => {
            if (!v) setThreadCompose(null)
          }}
          mode={threadCompose.mode}
          original={threadCompose.original}
          recipient={threadCompose.recipient}
        />
      )}
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
