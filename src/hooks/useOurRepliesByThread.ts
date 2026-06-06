// "우리가 각 Gmail thread 에 마지막으로 발송한 시각" 맵.
// thread_messages 중 status='sent' + gmail_thread_id 있는 행을 thread 별 최신 sent_at 으로 집계.
//
// 용도: inbound 메일이 "미응답" 인지 판정 — inbound.received_at 보다 우리 마지막 발송이 이전이면 미응답.
// InboxPage 와 useInboxStats 가 동일 데이터를 쓰므로 공용 hook 으로 묶어 React Query 캐시 공유
// (이전엔 queryKey 가 달라 같은 데이터를 2번 fetch).

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export function useOurRepliesByThread() {
  return useQuery({
    queryKey: ['our-replies-by-thread'],
    queryFn: async (): Promise<Record<string, string>> => {
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
}

/** inbound 1건이 미응답인지 — 같은 thread 에 우리 마지막 발송이 inbound 수신보다 이전(또는 없음) */
export function isInboundUnreplied(
  inbound: { gmail_thread_id: string | null; received_at: string },
  ourRepliesByThread: Record<string, string>,
): boolean {
  if (!inbound.gmail_thread_id) return true
  const ourLast = ourRepliesByThread[inbound.gmail_thread_id]
  if (!ourLast) return true
  return ourLast < inbound.received_at
}
