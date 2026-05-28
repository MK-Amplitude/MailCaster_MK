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

export type MailHistoryItem =
  | { kind: 'outbound'; ts: string; row: OutboundThreadMessage }
  | { kind: 'inbound'; ts: string; row: InboundMessage }

const QK = ['contact_mail_history']

/** Contact 의 outbound + inbound 메일을 시간 역순으로 통합 */
export function useContactMailHistory(contactId: string | undefined) {
  return useQuery({
    queryKey: [...QK, contactId],
    queryFn: async (): Promise<MailHistoryItem[]> => {
      if (!contactId) return []

      // outbound — thread_messages.contact_id = contactId
      const outboundP = supabase
        .from('thread_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(100)

      // inbound — inbound_messages.contact_id = contactId
      const inboundP = supabase
        .from('inbound_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('received_at', { ascending: false })
        .limit(100)

      const [out, inb] = await Promise.all([outboundP, inboundP])
      if (out.error) throw out.error
      if (inb.error) throw inb.error

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
