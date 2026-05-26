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

const QK = ['thread_messages']

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
    // 발송 중이거나 최근 발송된 row 가 있으면 짧게 폴링 — 오픈 카운터가 바뀔 수 있음
    refetchInterval: (q) => {
      const c = q.state.data as ThreadMessageRow[] | undefined
      if (!c || c.length === 0) return false
      const hasPending = c.some((m) => m.status === 'pending')
      return hasPending ? 2000 : false
    },
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
