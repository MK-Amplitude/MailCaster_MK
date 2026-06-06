// 분석 집계 — outbound 퍼널 + 세그먼트별 성과 (Tier 3 고도화).

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'

export type SegmentDimension = 'parent_group' | 'customer_type' | 'job_title'

export interface FunnelData {
  sent: number
  opened: number
  replied: number
}

export interface SegmentRow {
  segment: string
  sent: number
  opened: number
  replied: number
}

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600_000).toISOString()
}

export function useOutboundFunnel(days = 30) {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: ['analytics', 'funnel', currentOrg?.id, days],
    queryFn: async (): Promise<FunnelData> => {
      const { data, error } = await supabase.rpc('outbound_funnel', { p_since: sinceIso(days) })
      if (error) throw error
      const row = (data ?? [])[0]
      return {
        sent: Number(row?.sent) || 0,
        opened: Number(row?.opened) || 0,
        replied: Number(row?.replied) || 0,
      }
    },
    enabled: !!currentOrg,
  })
}

export function useSegmentPerformance(dimension: SegmentDimension, days = 30) {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: ['analytics', 'segment', currentOrg?.id, dimension, days],
    queryFn: async (): Promise<SegmentRow[]> => {
      const { data, error } = await supabase.rpc('reply_rate_by_segment', {
        p_since: sinceIso(days),
        p_dim: dimension,
      })
      if (error) throw error
      return ((data ?? []) as SegmentRow[]).map((r) => ({
        segment: r.segment,
        sent: Number(r.sent) || 0,
        opened: Number(r.opened) || 0,
        replied: Number(r.replied) || 0,
      }))
    },
    enabled: !!currentOrg,
  })
}
