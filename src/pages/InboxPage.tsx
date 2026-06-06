// 받은편지함 + 보낸편지함 — outbound + inbound 통합 페이지.
//
// 탭:
//   - 받은편지함: inbound_messages 시간역순 + 미응답 필터 + 회신 버튼
//   - 보낸편지함: thread_messages + recipients (캠페인) 통합 시간역순 + 오픈 추적
//
// 핵심: 보낸 모든 메일 (1통 ad-hoc 부터 캠페인까지) 의 오픈 횟수를 한곳에서 확인.

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import {
  Mail,
  Inbox,
  Send,
  AlertCircle,
  Eye,
  EyeOff,
  AlertTriangle,
  MessageCircle,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ThreadComposeDialog } from '@/components/campaigns/ThreadComposeDialog'
import { useOutboundFeed, type OutboundItem } from '@/hooks/useOutboundFeed'
import type { Database } from '@/types/database.types'
import { escapeHtml } from '@/lib/utils'

type InboundRow = Database['mailcaster']['Tables']['inbound_messages']['Row']

const QK = ['inbox']
const PAGE_SIZE = 50

export default function InboxPage() {
  const [tab, setTab] = useState<'inbound' | 'outbound'>('inbound')
  const [filter, setFilter] = useState<'all' | 'unreplied' | 'unopened'>('all')
  const [replyTo, setReplyTo] = useState<InboundRow | null>(null)
  const navigate = useNavigate()

  // ─── Inbound ────────────────────────────────────────────────
  const { data: rawInbound = [], isLoading: inboundLoading } = useQuery({
    queryKey: [...QK, 'inbound'],
    queryFn: async (): Promise<InboundRow[]> => {
      const { data, error } = await supabase
        .from('inbound_messages')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(PAGE_SIZE)
      if (error) throw error
      return data as InboundRow[]
    },
    refetchInterval: 60_000,
  })

  const { data: ourReplies = {} } = useQuery({
    queryKey: [...QK, 'our-replies'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('thread_messages')
        .select('gmail_thread_id, sent_at')
        .eq('status', 'sent')
        .not('gmail_thread_id', 'is', null)
      if (error) throw error
      const map: Record<string, string> = {}
      for (const row of data ?? []) {
        const tid = (row as { gmail_thread_id: string | null }).gmail_thread_id
        const sentAt = (row as { sent_at: string | null }).sent_at
        if (!tid || !sentAt) continue
        if (!map[tid] || sentAt > map[tid]) map[tid] = sentAt
      }
      return map
    },
  })

  const inboundItems = useMemo(() => {
    if (filter === 'unreplied') {
      return rawInbound.filter((m) => {
        if (!m.gmail_thread_id) return true
        const ourLast = ourReplies[m.gmail_thread_id]
        if (!ourLast) return true
        return ourLast < m.received_at
      })
    }
    return rawInbound
  }, [rawInbound, ourReplies, filter])

  const unrepliedCount = useMemo(() => {
    return rawInbound.filter((m) => {
      if (!m.gmail_thread_id) return true
      const ourLast = ourReplies[m.gmail_thread_id]
      if (!ourLast) return true
      return ourLast < m.received_at
    }).length
  }, [rawInbound, ourReplies])

  // ─── Outbound ────────────────────────────────────────────────
  const { data: outboundFeed = [], isLoading: outboundLoading } = useOutboundFeed(PAGE_SIZE)

  const outboundItems = useMemo(() => {
    if (filter === 'unopened') {
      return outboundFeed.filter((m) => !m.opened && !m.bounced && m.status === 'sent')
    }
    return outboundFeed
  }, [outboundFeed, filter])

  const unopenedCount = useMemo(
    () =>
      outboundFeed.filter((m) => !m.opened && !m.bounced && m.status === 'sent').length,
    [outboundFeed],
  )

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Inbox className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-semibold">메일함</h1>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as 'inbound' | 'outbound')
          // 탭 전환 시 filter 리셋 — 한 탭의 filter 값 (unreplied/unopened) 이 다른 탭으로
          // 넘어가면 두 버튼 다 비활성 표시되는 글리치 방지.
          setFilter('all')
        }}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="inbound" className="gap-2">
            <Inbox className="w-3.5 h-3.5" />
            받은편지함
            {unrepliedCount > 0 && (
              <Badge className="bg-orange-500 ml-1 h-4 px-1.5 text-[10px]">
                {unrepliedCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="outbound" className="gap-2">
            <Send className="w-3.5 h-3.5" />
            보낸편지함
            {unopenedCount > 0 && (
              <Badge className="bg-amber-500 ml-1 h-4 px-1.5 text-[10px]">
                미오픈 {unopenedCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─── 받은편지함 ─── */}
        <TabsContent value="inbound" className="mt-0">
          <div className="flex items-center justify-end mb-3">
            <div className="flex items-center gap-1 border rounded-md p-0.5">
              <Button
                size="sm"
                variant={filter === 'all' ? 'default' : 'ghost'}
                onClick={() => setFilter('all')}
                className="h-7"
              >
                전체 ({rawInbound.length})
              </Button>
              <Button
                size="sm"
                variant={filter === 'unreplied' ? 'default' : 'ghost'}
                onClick={() => setFilter('unreplied')}
                className="h-7"
              >
                미응답 ({unrepliedCount})
              </Button>
            </div>
          </div>

          {inboundLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중...</div>
          ) : inboundItems.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <Inbox className="w-12 h-12 text-muted-foreground/50 mx-auto" />
              <div className="text-sm text-muted-foreground">
                {filter === 'unreplied'
                  ? '미응답 메일이 없습니다. 잘하고 계세요 👍'
                  : '아직 받은 메일이 없습니다. 5분 주기로 자동 감지됩니다.'}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {inboundItems.map((m) => (
                <InboundCard key={m.id} item={m} onReplyClick={setReplyTo} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ─── 보낸편지함 ─── */}
        <TabsContent value="outbound" className="mt-0">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-muted-foreground">
              ad-hoc 1:1 / 팔로업 / 회신 / 전달 / 캠페인 발송을 모두 포함합니다.
            </div>
            <div className="flex items-center gap-1 border rounded-md p-0.5">
              <Button
                size="sm"
                variant={filter === 'all' ? 'default' : 'ghost'}
                onClick={() => setFilter('all')}
                className="h-7"
              >
                전체 ({outboundFeed.length})
              </Button>
              <Button
                size="sm"
                variant={filter === 'unopened' ? 'default' : 'ghost'}
                onClick={() => setFilter('unopened')}
                className="h-7"
              >
                미오픈 ({unopenedCount})
              </Button>
            </div>
          </div>

          {outboundLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중...</div>
          ) : outboundItems.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <Send className="w-12 h-12 text-muted-foreground/50 mx-auto" />
              <div className="text-sm text-muted-foreground">
                아직 발송한 메일이 없습니다.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {outboundItems.map((m) => (
                <OutboundCard
                  key={`${m.kind}-${m.id}`}
                  item={m}
                  onCampaignClick={(cid) => navigate(`/campaigns/${cid}`)}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {replyTo && (
        <ThreadComposeDialog
          key={replyTo.id}
          open={!!replyTo}
          onOpenChange={(o) => !o && setReplyTo(null)}
          mode="reply"
          original={{
            gmailThreadId: replyTo.gmail_thread_id,
            gmailMessageId: replyTo.gmail_message_id,
            rfcMessageId: replyTo.rfc_message_id,
            subject: replyTo.subject,
            // 외부 발신자 HTML XSS 방지 — body_html raw fallback 제거, escape 된 text 만.
            bodyHtml: `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(
              replyTo.body_text || replyTo.snippet || '',
            )}</pre>`,
            fromLabel: replyTo.from_name
              ? `${replyTo.from_name} <${replyTo.from_email}>`
              : replyTo.from_email,
            sentAt: replyTo.received_at,
          }}
          recipient={{
            email: replyTo.from_email,
            name: replyTo.from_name,
            contactId: replyTo.contact_id,
            recipientId: null,
            campaignId: null,
          }}
        />
      )}
    </div>
  )
}

function InboundCard({
  item,
  onReplyClick,
}: {
  item: InboundRow
  onReplyClick: (m: InboundRow) => void
}) {
  const ts = format(new Date(item.received_at), 'M월 d일 HH:mm', { locale: ko })
  return (
    <div className="border rounded-lg p-3 hover:bg-muted/30 transition-colors flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="font-medium text-sm">
            {item.from_name ?? item.from_email}
          </span>
          <span className="text-xs text-muted-foreground">&lt;{item.from_email}&gt;</span>
          <span className="text-xs text-muted-foreground ml-auto">{ts}</span>
        </div>
        <div className="font-medium text-sm truncate">{item.subject || '(제목 없음)'}</div>
        {(item.body_text || item.snippet) && (
          <div className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
            {item.body_text || item.snippet}
          </div>
        )}
        {!item.contact_id && (
          <div className="text-xs text-amber-600 dark:text-amber-400 mt-1 inline-flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            연락처 매칭 안 됨
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={() => onReplyClick(item)}>
        <Mail className="w-3.5 h-3.5 mr-1" />
        회신
      </Button>
    </div>
  )
}

function OutboundCard({
  item,
  onCampaignClick,
}: {
  item: OutboundItem
  onCampaignClick: (campaignId: string) => void
}) {
  const ts = format(new Date(item.ts), 'M월 d일 HH:mm', { locale: ko })
  return (
    <div className="border rounded-lg p-3 hover:bg-muted/30 transition-colors flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <Badge variant="secondary" className="text-xs">
            {item.modeLabel}
          </Badge>
          <span className="font-medium text-sm">{item.toLabel}</span>
          {item.toLabel !== item.toEmail && (
            <span className="text-xs text-muted-foreground">&lt;{item.toEmail}&gt;</span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">{ts}</span>
        </div>
        <div className="font-medium text-sm truncate mb-1">
          {item.subject || '(제목 없음)'}
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <StatusBadge status={item.status} bounced={item.bounced} />
          {/* 핵심 — 발송된 모든 메일에 일관된 오픈 표시 */}
          {!item.bounced && item.status === 'sent' && (
            <OpenBadge opened={item.opened} openCount={item.openCount} />
          )}
          {!item.bounced && item.replied && item.replyCount > 0 && (
            <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
              <MessageCircle className="w-3 h-3" />
              회신 {item.replyCount}
            </span>
          )}
          {item.kind === 'campaign' && item.campaignId && (
            <button
              type="button"
              onClick={() => onCampaignClick(item.campaignId!)}
              className="text-muted-foreground hover:text-foreground transition-colors ml-auto"
            >
              캠페인 상세 →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function OpenBadge({ opened, openCount }: { opened: boolean; openCount: number }) {
  if (opened) {
    return (
      <span
        className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
        title={`총 ${openCount}회 열어봤습니다`}
      >
        <Eye className="w-3 h-3" />
        {openCount}회 오픈
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title="아직 미오픈">
      <EyeOff className="w-3 h-3" />
      미오픈
    </span>
  )
}

function StatusBadge({
  status,
  bounced,
}: {
  status: 'pending' | 'sent' | 'failed'
  bounced: boolean
}) {
  if (bounced) {
    return (
      <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400">
        <AlertTriangle className="w-3 h-3" />
        반송
      </span>
    )
  }
  if (status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
        <CheckCircle2 className="w-3 h-3" />
        성공
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
        <XCircle className="w-3 h-3" />
        실패
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
      <Clock className="w-3 h-3" />
      발송 중
    </span>
  )
}
