// thread_messages 조회 hook.
// 캠페인 단위 / 연락처 단위 / 수신자 단위 — 셋 다 같은 테이블에서 가져옴.
//
// 정렬: created_at DESC — 최근 보낸 것이 위로.
// 오픈 추적 결과는 thread_messages row 자체에 요약 (opened/open_count 등) 으로 들어가니
// 별도 join 불필요.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database.types'

export type ThreadMessageRow = Database['mailcaster']['Tables']['thread_messages']['Row']
export type ThreadMessageReply =
  Database['mailcaster']['Tables']['thread_message_replies']['Row']

const QK = ['thread_messages']

// 최근 발송 후 회신/오픈 갱신을 자동 반영하기 위한 폴링 윈도우 (밀리초).
// cron 이 5분 주기라 너무 자주 polling 해도 효용 없음. 발송 직후 60분 동안만 30초 간격.
const THREAD_RECENT_WINDOW_MS = 60 * 60 * 1000
const THREAD_RECENT_POLL_MS = 30_000

/** 특정 캠페인에 연관된 thread_messages 전체 */
export function useThreadMessagesByCampaign(campaignId: string | undefined) {
  return useQuery({
    queryKey: [...QK, 'campaign', campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('thread_messages')
        .select('*')
        .eq('campaign_id', campaignId!)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as ThreadMessageRow[]
    },
    enabled: !!campaignId,
    // 폴링 정책:
    //   - pending row 있음 → 2초 (발송 완료 빨리 반영)
    //   - 최근 1시간 안에 발송된 row 있음 → 30초 (cron 이 회신/오픈 업데이트 한 걸 반영)
    //   - 그 외 → 폴링 안 함 (사용자가 새로고침해야 함)
    refetchInterval: (q) => {
      const c = q.state.data as ThreadMessageRow[] | undefined
      if (!c || c.length === 0) return false
      if (c.some((m) => m.status === 'pending')) return 2000
      const now = Date.now()
      const hasRecent = c.some((m) => {
        if (!m.sent_at) return false
        return now - new Date(m.sent_at).getTime() < THREAD_RECENT_WINDOW_MS
      })
      return hasRecent ? THREAD_RECENT_POLL_MS : false
    },
  })
}

/** 특정 thread_message 가 받은 회신들 (received) */
export function useThreadMessageReplies(threadMessageId: string | undefined) {
  return useQuery({
    queryKey: [...QK, 'replies', threadMessageId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('thread_message_replies')
        .select('*')
        .eq('thread_message_id', threadMessageId!)
        .order('received_at', { ascending: true })
      if (error) throw error
      return (data ?? []) as ThreadMessageReply[]
    },
    enabled: !!threadMessageId,
  })
}

/** 특정 연락처에 보낸 thread_messages — 향후 ContactDetailSheet 에서 사용 */
export function useThreadMessagesByContact(contactId: string | undefined) {
  return useQuery({
    queryKey: [...QK, 'contact', contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('thread_messages')
        .select('*')
        .eq('contact_id', contactId!)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as ThreadMessageRow[]
    },
    enabled: !!contactId,
  })
}
