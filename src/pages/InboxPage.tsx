// 받은편지함 — inbound_messages 통합 리스트.
// Contact 가 우리에게 보낸 모든 메일 (캠페인 회신 / cold inbound 통합) 시간 역순.
//
// 액션: 회신 버튼 → ThreadComposeDialog reply 모드
// 필터: 미응답 / 전체

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Mail, Inbox, AlertCircle } from 'lucide-react'
import { ThreadComposeDialog } from '@/components/campaigns/ThreadComposeDialog'
import type { Database } from '@/types/database.types'
import { escapeHtml } from '@/lib/utils'

type InboundRow = Database['mailcaster']['Tables']['inbound_messages']['Row']

const QK = ['inbox']
const PAGE_SIZE = 50

export default function InboxPage() {
  const [filter, setFilter] = useState<'all' | 'unreplied'>('all')
  const [replyTo, setReplyTo] = useState<InboundRow | null>(null)

  const { data: rawInbound = [], isLoading } = useQuery({
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
    // 새 메일 5분 cron 결과 자동 반영 — 1분마다 폴링
    refetchInterval: 60_000,
  })

  // "미응답" 판단: 같은 gmail_thread_id 로 우리가 보낸 thread_messages 가 없거나,
  //              우리가 답한 시점이 inbound.received_at 이전인 경우.
  // 정확한 판정은 client 에서 join — 간단한 구현: thread_messages 의 같은 thread 의
  // 우리 발송 시각을 비교. 받는 사람 답장 후 우리가 안 답한 상태.
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

  const items = useMemo(() => {
    if (filter === 'all') return rawInbound
    // unreplied: 같은 thread 의 우리 마지막 발송 시각이 inbound 이전이거나 없음
    return rawInbound.filter((m) => {
      if (!m.gmail_thread_id) return true
      const ourLast = ourReplies[m.gmail_thread_id]
      if (!ourLast) return true
      return ourLast < m.received_at
    })
  }, [rawInbound, ourReplies, filter])

  const unrepliedCount = useMemo(() => {
    return rawInbound.filter((m) => {
      if (!m.gmail_thread_id) return true
      const ourLast = ourReplies[m.gmail_thread_id]
      if (!ourLast) return true
      return ourLast < m.received_at
    }).length
  }, [rawInbound, ourReplies])

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Inbox className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-semibold">받은편지함</h1>
          {unrepliedCount > 0 && (
            <Badge variant="default" className="bg-orange-500">
              미응답 {unrepliedCount}
            </Badge>
          )}
        </div>
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

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중...</div>
      ) : items.length === 0 ? (
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
          {items.map((m) => (
            <InboundRowCard key={m.id} item={m} onReplyClick={setReplyTo} />
          ))}
        </div>
      )}

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
            bodyHtml: replyTo.body_text
              ? `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(replyTo.body_text)}</pre>`
              : replyTo.body_html,
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

function InboundRowCard({
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
        <div className="font-medium text-sm truncate">
          {item.subject || '(제목 없음)'}
        </div>
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
