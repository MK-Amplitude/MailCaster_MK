// 받은편지함 통계 — 대시보드 KPI 카드용.
// InboxPage 와 동일 쿼리를 사용하므로 React Query 캐시 공유로 중복 fetch 없음.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useOurRepliesByThread, isInboundUnreplied } from './useOurRepliesByThread'

interface InboxStats {
  total: number
  todayCount: number
  unrepliedCount: number
  // 최근 30일 outbound 발송 + 오픈 통계 (모든 발송 = thread + 캠페인)
  outboundSentCount: number
  outboundOpenedCount: number
  outboundUnopenedCount: number
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

  // 최근 30일 outbound 통계 — thread_messages + recipients 합산.
  const { data: outboundStats = { sent: 0, opened: 0 } } = useQuery({
    queryKey: ['inbox-stats', 'outbound', sinceIso],
    queryFn: async () => {
      const threadP = supabase
        .from('thread_messages')
        .select('opened, bounced, status')
        .eq('status', 'sent')
        .gte('sent_at', sinceIso)
      const recP = supabase
        .from('recipients')
        .select('opened, bounced, status')
        .in('status', ['sent', 'bounced'])
        .gte('sent_at', sinceIso)
      const [t, r] = await Promise.all([threadP, recP])
      let sent = 0
      let opened = 0
      for (const row of t.data ?? []) {
        const rr = row as { opened?: boolean; bounced?: boolean }
        if (rr.bounced) continue
        sent++
        if (rr.opened) opened++
      }
      for (const row of r.data ?? []) {
        const rr = row as { opened?: boolean; bounced?: boolean }
        if (rr.bounced) continue
        sent++
        if (rr.opened) opened++
      }
      return { sent, opened }
    },
    refetchInterval: 60_000,
  })

  // InboxPage 와 캐시 공유 — 중복 fetch 제거
  const { data: ourSentByThread = {} } = useOurRepliesByThread()

  return useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()
    let todayCount = 0
    let unrepliedCount = 0
    for (const m of inbound) {
      if (new Date(m.received_at).getTime() >= todayStartMs) todayCount++
      if (isInboundUnreplied(m, ourSentByThread)) unrepliedCount++
    }
    return {
      total: inbound.length,
      todayCount,
      unrepliedCount,
      outboundSentCount: outboundStats.sent,
      outboundOpenedCount: outboundStats.opened,
      outboundUnopenedCount: Math.max(0, outboundStats.sent - outboundStats.opened),
    }
  }, [inbound, ourSentByThread, outboundStats])
}
