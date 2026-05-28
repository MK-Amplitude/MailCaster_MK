// 받은편지함 통계 — 대시보드 KPI 카드용.
// InboxPage 와 동일 쿼리를 사용하므로 React Query 캐시 공유로 중복 fetch 없음.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { supabase } from '@/lib/supabase'

interface InboxStats {
  total: number
  todayCount: number
  unrepliedCount: number
}

export function useInboxStats(): InboxStats {
  // 최근 30일 inbound 만 — 더 오래된 건 통계에서 제외 (성능 + 의미)
  const sinceIso = useMemo(
    () => new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    [],
  )

  const { data: inbound = [] } = useQuery({
    queryKey: ['inbox-stats', 'inbound', sinceIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('inbound_messages')
        .select('id, gmail_thread_id, received_at')
        .gte('received_at', sinceIso)
      if (error) throw error
      return (data ?? []) as Array<{
        id: string
        gmail_thread_id: string | null
        received_at: string
      }>
    },
    refetchInterval: 60_000,
  })

  const { data: ourSentByThread = {} } = useQuery({
    queryKey: ['inbox-stats', 'our-sent-by-thread'],
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

  return useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()
    let todayCount = 0
    let unrepliedCount = 0
    for (const m of inbound) {
      if (new Date(m.received_at).getTime() >= todayStartMs) todayCount++
      if (!m.gmail_thread_id) {
        unrepliedCount++
        continue
      }
      const ourLast = ourSentByThread[m.gmail_thread_id]
      if (!ourLast || ourLast < m.received_at) unrepliedCount++
    }
    return { total: inbound.length, todayCount, unrepliedCount }
  }, [inbound, ourSentByThread])
}
