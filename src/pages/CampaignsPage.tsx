import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { useCampaigns, useDeleteCampaign } from '@/hooks/useCampaigns'
import { matchesSearch } from '@/lib/search'
import { Mail, Plus, Search, Trash2, Eye, Send, Clock, CheckCircle2, XCircle, FileEdit, CalendarClock } from 'lucide-react'
import type { Campaign, CampaignStatus } from '@/types/campaign'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'

type StatusFilter = CampaignStatus | 'all'

const STATUS_META: Record<
  CampaignStatus,
  { label: string; color: string; icon: typeof FileEdit }
> = {
  draft: { label: '초안', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', icon: FileEdit },
  scheduled: { label: '예약', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', icon: Clock },
  sending: { label: '발송중', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', icon: Send },
  sent: { label: '완료', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', icon: CheckCircle2 },
  paused: { label: '일시정지', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', icon: Clock },
  failed: { label: '실패', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', icon: XCircle },
}

export default function CampaignsPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<StatusFilter>('all')
  const { data: campaigns = [], isLoading } = useCampaigns(status)
  const deleteCampaign = useDeleteCampaign()

  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim()
    if (!q) return campaigns
    return campaigns.filter((c) => matchesSearch(c.name, q))
  }, [campaigns, search])

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">메일 발송</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {campaigns.length}건의 메일 발송
            </p>
          </div>
          <Button size="sm" onClick={() => navigate('/campaigns/new')} className="shrink-0">
            <Plus className="w-4 h-4 sm:mr-1.5" />
            <span className="hidden sm:inline">새 메일 발송</span>
            <span className="sm:hidden">새 발송</span>
          </Button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <TabsList className="h-8">
              <TabsTrigger value="all" className="text-xs h-7">전체</TabsTrigger>
              <TabsTrigger value="draft" className="text-xs h-7">초안</TabsTrigger>
              <TabsTrigger value="scheduled" className="text-xs h-7">예약</TabsTrigger>
              <TabsTrigger value="sending" className="text-xs h-7">발송중</TabsTrigger>
              <TabsTrigger value="sent" className="text-xs h-7">완료</TabsTrigger>
              <TabsTrigger value="failed" className="text-xs h-7">실패</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="발송 이름으로 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Mail}
            title={search ? '검색 결과가 없습니다' : '발송 내역이 없습니다'}
            description="그룹 또는 개별 연락처를 선택해 첫 메일 발송을 만들어보세요."
            action={search ? undefined : { label: '새 메일 발송', onClick: () => navigate('/campaigns/new') }}
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((c) => (
              <CampaignRow
                key={c.id}
                campaign={c}
                onOpen={() => navigate(`/campaigns/${c.id}`)}
                onDelete={() => setDeleteTarget(c)}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="메일 발송 삭제"
        description={`"${deleteTarget?.name}" 메일 발송을 삭제하시겠습니까? 수신자 내역도 함께 삭제됩니다.`}
        confirmLabel="삭제"
        variant="destructive"
        loading={deleteCampaign.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteCampaign.mutateAsync(deleteTarget.id)
            setDeleteTarget(null)
          } catch {
            // onError 에서 토스트 표시
          }
        }}
      />
    </div>
  )
}

function CampaignRow({
  campaign,
  onOpen,
  onDelete,
}: {
  campaign: Campaign
  onOpen: () => void
  onDelete: () => void
}) {
  const meta = STATUS_META[campaign.status as CampaignStatus] ?? STATUS_META.draft
  const Icon = meta.icon
  const progress =
    campaign.total_count > 0
      ? Math.round(((campaign.sent_count + campaign.failed_count) / campaign.total_count) * 100)
      : 0
  // 성공률: 실제 처리된(sent + failed) 것 중 성공 비율. 처리 전이면 '-'
  const processedCount = campaign.sent_count + campaign.failed_count
  const successRate = processedCount > 0
    ? Math.round((campaign.sent_count / processedCount) * 1000) / 10 // 소수 1자리
    : null
  // 성공률 배지 색상 — 90% 이상 초록, 50~90 중간(slate), 이하 빨강
  const successRateTone =
    successRate === null
      ? 'text-muted-foreground'
      : successRate >= 90
        ? 'text-green-600 dark:text-green-400'
        : successRate >= 50
          ? 'text-slate-600 dark:text-slate-300'
          : 'text-red-600 dark:text-red-400'

  return (
    <Card className="hover:border-primary/30 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 cursor-pointer" onClick={onOpen}>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{campaign.name}</h3>
              <Badge className={`text-[10px] py-0 px-1.5 ${meta.color}`} variant="secondary">
                <Icon className="w-3 h-3 mr-1" />
                {meta.label}
              </Badge>
              {/* 예약 시각 배지 — scheduled 일 때만 */}
              {campaign.status === 'scheduled' && campaign.scheduled_at && (
                <Badge
                  variant="outline"
                  className="text-[10px] py-0 px-1.5 border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300"
                >
                  <CalendarClock className="w-3 h-3 mr-1" />
                  {format(new Date(campaign.scheduled_at), 'M월 d일 HH:mm', { locale: ko })}
                  {' · '}
                  {formatRelativeFuture(campaign.scheduled_at)}
                </Badge>
              )}
            </div>
            {campaign.subject && (
              <p className="text-xs text-muted-foreground truncate mb-2">{campaign.subject}</p>
            )}
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
              <span>총 {campaign.total_count}명</span>
              {campaign.status === 'sending' && (
                <span className="text-amber-600 dark:text-amber-400">진행 {progress}%</span>
              )}
              {(campaign.status === 'sent' || campaign.status === 'failed') && (
                <>
                  <span className="text-green-600 dark:text-green-400">성공 {campaign.sent_count}</span>
                  {campaign.failed_count > 0 && (
                    <span className="text-red-600 dark:text-red-400">실패 {campaign.failed_count}</span>
                  )}
                  {successRate !== null && (
                    <span className={`font-medium ${successRateTone}`}>
                      성공률 {successRate.toFixed(1)}%
                    </span>
                  )}
                </>
              )}
              <span>
                {format(new Date(campaign.created_at), 'yyyy년 M월 d일 HH:mm', { locale: ko })}
              </span>
            </div>

            {campaign.status === 'sending' && campaign.total_count > 0 && (
              <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onOpen} title="상세">
              <Eye className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              title="삭제"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// "5분 뒤", "3시간 뒤", "2일 뒤" — 예약 배지에 간단한 상대 시간 표기.
// 이미 과거면 "지연" 으로 표시 (cron 이 아직 못 집어간 경우)
function formatRelativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return '발송 대기'
  const min = Math.round(ms / 60_000)
  if (min < 1) return '곧'
  if (min < 60) return `${min}분 뒤`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}시간 뒤`
  const day = Math.round(hr / 24)
  return `${day}일 뒤`
}
