// 받은편지함 통계 — 대시보드 KPI 카드용.
// 단일 집계 RPC(inbox_stats)로 DB 에서 계산 — 기존엔 30일치 전량을 클라로 가져와
// JS 루프로 집계했으나, 페이로드·확장성 문제로 SQL 집계로 이관 (고도화 QW2).

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

interface InboxStats {
  total: number
  todayCount: number
  unrepliedCount: number
  // 최근 30일 outbound 발송 + 오픈 통계 (모든 발송 = thread + 캠페인)
  outboundSentCount: number
  outboundOpenedCount: number
  outboundUnopenedCount: number
}

const EMPTY: InboxStats = {
  total: 0,
  todayCount: 0,
  unrepliedCount: 0,
  outboundSentCount: 0,
  outboundOpenedCount: 0,
  outboundUnopenedCount: 0,
}

export function useInboxStats(): InboxStats {
  const { data } = useQuery({
    queryKey: ['inbox-stats'],
    queryFn: async (): Promise<InboxStats> => {
      // 최근 30일 윈도 + "오늘" 경계(로컬 자정)는 매 호출 시 계산 → 60초 refetch 마다 갱신.
      const sinceIso = new Date(Date.now() - 30 * 24 * 3600_000).toISOString()
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const { data, error } = await supabase.rpc('inbox_stats', {
        p_since: sinceIso,
        p_today_start: todayStart.toISOString(),
      })
      if (error) throw error
      const row = (data ?? [])[0]
      if (!row) return EMPTY
      const sent = Number(row.outbound_sent) || 0
      const opened = Number(row.outbound_opened) || 0
      return {
        total: Number(row.total) || 0,
        todayCount: Number(row.today_count) || 0,
        unrepliedCount: Number(row.unreplied_count) || 0,
        outboundSentCount: sent,
        outboundOpenedCount: opened,
        outboundUnopenedCount: Math.max(0, sent - opened),
      }
    },
    refetchInterval: 60_000,
  })

  return data ?? EMPTY
}
