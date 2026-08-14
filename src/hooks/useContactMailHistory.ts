// Contact 한 명의 통합 메일 히스토리.
// outbound (thread_messages) + inbound (inbound_messages) 를 시간순으로 합쳐 반환.
//
// 사용처: ContactDetailSheet 의 "메일 히스토리" 탭

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database.types'

export type InboundMessage = Database['mailcaster']['Tables']['inbound_messages']['Row']
export type OutboundThreadMessage =
  Database['mailcaster']['Tables']['thread_messages']['Row']
export type CampaignRecipientRow = Database['mailcaster']['Tables']['recipients']['Row']

// 캠페인 발송 1건의 메일 히스토리 항목 — recipients + campaign 메타 join
export interface CampaignMailRow {
  recipient: CampaignRecipientRow
  campaignSubject: string | null
  campaignBodyHtml: string | null
  campaignId: string
}

export type MailHistoryItem =
  | { kind: 'outbound'; ts: string; row: OutboundThreadMessage }
  | { kind: 'inbound'; ts: string; row: InboundMessage }
  | { kind: 'campaign'; ts: string; row: CampaignMailRow }

const QK = ['contact_mail_history']

/** Contact 의 outbound thread_messages + inbound + 캠페인 발송 메일을 시간 역순으로 통합 */
export function useContactMailHistory(contactId: string | undefined) {
  return useQuery({
    queryKey: [...QK, contactId],
    queryFn: async (): Promise<MailHistoryItem[]> => {
      if (!contactId) return []

      // outbound thread_messages — 1:1 후속 (followup/reply/forward/new)
      const outboundP = supabase
        .from('thread_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(100)

      // inbound — 받은 메일
      const inboundP = supabase
        .from('inbound_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('received_at', { ascending: false })
        .limit(100)

      // 캠페인 발송 메일 — recipients 만 먼저 가져오고 campaign 메타는 별도 1회 조회.
      // embedded join 은 같은 캠페인의 body_html(수십~수백 KB)이 수신자 행마다
      // 중복 전송돼 히스토리 1회 로드가 수 MB 가 되던 문제 (30초 폴링과 결합 시 심각).
      const campaignP = supabase
        .from('recipients')
        .select('*')
        .eq('contact_id', contactId)
        .in('status', ['sent', 'bounced', 'failed'])
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(100)

      const [out, inb, cam] = await Promise.all([outboundP, inboundP, campaignP])
      if (out.error) throw out.error
      if (inb.error) throw inb.error
      if (cam.error) throw cam.error

      // 캠페인 메타 별도 조회 — 고유 campaign_id 만 (같은 캠페인 body 1회씩만 전송)
      const campaignIds = Array.from(
        new Set(
          ((cam.data ?? []) as CampaignRecipientRow[])
            .map((r) => r.campaign_id)
            .filter((id): id is string => !!id),
        ),
      )
      const campaignMetaMap = new Map<
        string,
        { id: string; subject: string | null; body_html: string | null }
      >()
      if (campaignIds.length > 0) {
        const { data: campMeta, error: campErr } = await supabase
          .from('campaigns')
          .select('id, subject, body_html')
          .in('id', campaignIds)
        if (campErr) throw campErr
        for (const cRow of campMeta ?? []) {
          campaignMetaMap.set(cRow.id, cRow)
        }
      }

      const items: MailHistoryItem[] = []
      for (const row of out.data ?? []) {
        items.push({
          kind: 'outbound',
          ts: row.sent_at ?? row.created_at,
          row: row as OutboundThreadMessage,
        })
      }
      for (const row of inb.data ?? []) {
        items.push({
          kind: 'inbound',
          ts: row.received_at,
          row: row as InboundMessage,
        })
      }
      for (const row of (cam.data ?? []) as CampaignRecipientRow[]) {
        const camp = row.campaign_id ? campaignMetaMap.get(row.campaign_id) : undefined
        if (!camp) continue
        const ts = row.sent_at ?? row.created_at ?? new Date(0).toISOString()
        items.push({
          kind: 'campaign',
          ts,
          row: {
            recipient: row,
            campaignSubject: camp.subject ?? null,
            campaignBodyHtml: camp.body_html ?? null,
            campaignId: camp.id,
          },
        })
      }
      items.sort((a, b) => b.ts.localeCompare(a.ts))
      return items
    },
    enabled: !!contactId,
    // 최근 1시간 안에 활동이 있으면 30초마다 폴링 (새 inbound 자동 반영)
    refetchInterval: (q) => {
      const items = q.state.data as MailHistoryItem[] | undefined
      if (!items || items.length === 0) return false
      const now = Date.now()
      const hasRecent = items.some((it) => now - new Date(it.ts).getTime() < 60 * 60 * 1000)
      return hasRecent ? 30_000 : false
    },
  })
}
