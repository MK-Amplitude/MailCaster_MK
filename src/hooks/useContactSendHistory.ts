// 연락처 한 명의 메일 발송 이력 — recipients + campaigns join.
// 관계 관리 detail sheet 에 timeline 으로 표시.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { ReplyCategory } from '@/types/replyCategory'

export interface SendHistoryRow {
  recipient_id: string
  campaign_id: string
  campaign_name: string
  campaign_subject: string | null
  sent_at: string | null
  opened: boolean
  open_count: number
  replied: boolean
  replied_at: string | null
  bounced: boolean
  // Gmail thread id — 답장 클릭 시 Gmail 새 탭으로 점프하기 위해 필요
  gmail_thread_id: string | null
  /** 답장 자동 분류 (migration 028). 답장 없거나 미분류면 null. */
  reply_category: ReplyCategory | null
}

const QK = 'contact-send-history'

export function useContactSendHistory(contactId: string | null | undefined) {
  return useQuery({
    queryKey: [QK, contactId],
    queryFn: async (): Promise<SendHistoryRow[]> => {
      // recipients → campaigns(name, subject) 조인. 발송된(sent) 것만.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('recipients') as any)
        .select(
          'id, campaign_id, sent_at, opened, open_count, replied, replied_at, bounced, gmail_thread_id, reply_category, campaigns:campaign_id(name, subject)'
        )
        .eq('contact_id', contactId!)
        .eq('status', 'sent')
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(20)
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        recipient_id: r.id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaigns?.name ?? '(이름 없음)',
        campaign_subject: r.campaigns?.subject ?? null,
        sent_at: r.sent_at,
        opened: r.opened,
        open_count: r.open_count ?? 0,
        replied: r.replied,
        replied_at: r.replied_at,
        bounced: r.bounced,
        gmail_thread_id: r.gmail_thread_id ?? null,
        reply_category: (r.reply_category ?? null) as ReplyCategory | null,
      }))
    },
    enabled: !!contactId,
  })
}
