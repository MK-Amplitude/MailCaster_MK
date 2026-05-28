// 발송한 모든 메일 통합 timeline.
// thread_messages (followup/reply/forward/new) + recipients (캠페인 발송) 시간역순.
//
// 핵심: 1통이든 다수든 모든 발송 메일에 일관된 오픈 추적 정보 제공.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database.types'

type ThreadRow = Database['mailcaster']['Tables']['thread_messages']['Row']
type RecipientRow = Database['mailcaster']['Tables']['recipients']['Row']

export interface OutboundItem {
  kind: 'thread' | 'campaign'
  ts: string  // sent_at 또는 created_at
  /** 통합 표시용 — 받는 사람 (이름 또는 이메일) */
  toLabel: string
  toEmail: string
  subject: string | null
  /** 모드 라벨 (캠페인 / 팔로업 / 회신 / 전달 / 새 메일) */
  modeLabel: string
  status: 'pending' | 'sent' | 'failed'
  opened: boolean
  openCount: number
  firstOpenedAt: string | null
  lastOpenedAt: string | null
  bounced: boolean
  replied: boolean
  replyCount: number
  /** 원본 link — 클릭 시 캠페인 또는 contact 페이지 이동 */
  contactId: string | null
  campaignId: string | null
  /** ThreadComposeDialog reply 모드 진입용 */
  gmailThreadId: string | null
  gmailMessageId: string | null
  rfcMessageId: string | null
  /** key 용 */
  id: string
}

const QK = ['outbound-feed']

/** 발송된 모든 메일 (thread + campaign recipients) 시간 역순 통합 */
export function useOutboundFeed(limit = 100) {
  return useQuery({
    queryKey: [...QK, limit],
    queryFn: async (): Promise<OutboundItem[]> => {
      const threadP = supabase
        .from('thread_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)

      // recipients + campaigns 를 두 쿼리로 분리 후 manual join (FK relation 자동 추론 미지원).
      const recP = supabase
        .from('recipients')
        .select('*')
        .in('status', ['sent', 'bounced', 'failed'])
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(limit)

      const [th, rec] = await Promise.all([threadP, recP])
      if (th.error) throw th.error
      if (rec.error) throw rec.error

      // 캠페인 메타 한 번에 fetch
      const campaignIds = Array.from(
        new Set((rec.data ?? []).map((r) => r.campaign_id).filter((v): v is string => !!v)),
      )
      const campaignsMap = new Map<string, { id: string; subject: string | null; name: string | null }>()
      if (campaignIds.length > 0) {
        const { data: camps, error: cErr } = await supabase
          .from('campaigns')
          .select('id, subject, name')
          .in('id', campaignIds)
        if (cErr) throw cErr
        for (const c of (camps ?? []) as Array<{ id: string; subject: string | null; name: string | null }>) {
          campaignsMap.set(c.id, c)
        }
      }
      const ca = { data: rec.data, error: null as null }

      const items: OutboundItem[] = []
      for (const row of (th.data ?? []) as ThreadRow[]) {
        items.push({
          kind: 'thread',
          id: row.id,
          ts: row.sent_at ?? row.created_at,
          toLabel: row.to_name ?? row.to_email,
          toEmail: row.to_email,
          subject: row.subject,
          modeLabel: modeLabelKr(row.mode),
          status: row.status,
          opened: row.opened,
          openCount: row.open_count,
          firstOpenedAt: row.first_opened_at,
          lastOpenedAt: row.last_opened_at,
          bounced: row.bounced,
          replied: row.replied,
          replyCount: row.reply_count,
          contactId: row.contact_id,
          campaignId: row.campaign_id,
          gmailThreadId: row.gmail_thread_id,
          gmailMessageId: row.gmail_message_id,
          rfcMessageId: row.rfc_message_id,
        })
      }
      for (const row of (ca.data ?? []) as RecipientRow[]) {
        const camp = row.campaign_id ? campaignsMap.get(row.campaign_id) : null
        if (!camp) continue
        items.push({
          kind: 'campaign',
          id: row.id,
          ts: row.sent_at ?? row.created_at,
          toLabel: row.name ?? row.email,
          toEmail: row.email,
          subject: camp.subject,
          modeLabel: '캠페인',
          status:
            row.status === 'sent' || row.status === 'failed'
              ? row.status
              : row.status === 'bounced'
                ? 'sent' // bounced 는 발송된 거니까 sent 로 표시 (bounced flag 별도)
                : 'pending',
          opened: row.opened ?? false,
          openCount: row.open_count ?? 0,
          firstOpenedAt: row.first_opened_at ?? null,
          lastOpenedAt: row.opened_at ?? null,
          bounced: row.bounced ?? false,
          replied: row.replied ?? false,
          replyCount: 0, // recipients 에 reply_count 없음 (캠페인 단위 집계만)
          contactId: row.contact_id,
          campaignId: row.campaign_id,
          gmailThreadId: row.gmail_thread_id,
          gmailMessageId: row.gmail_message_id,
          rfcMessageId: null, // recipients 는 rfc_message_id 컬럼 없음
        })
      }
      items.sort((a, b) => b.ts.localeCompare(a.ts))
      return items.slice(0, limit)
    },
    refetchInterval: 60_000,
  })
}

function modeLabelKr(mode: ThreadRow['mode']): string {
  switch (mode) {
    case 'followup':
      return '팔로업'
    case 'reply':
      return '회신'
    case 'forward':
      return '전달'
    case 'new':
      return '새 메일'
  }
}
