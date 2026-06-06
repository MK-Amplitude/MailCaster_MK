// 시퀀스 자동 발송 가드레일 설정 (org_send_settings) — 조회/저장 (Tier2-B).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'
import type { Database } from '@/types/database.types'

type Row = Database['mailcaster']['Tables']['org_send_settings']['Row']
type Insert = Database['mailcaster']['Tables']['org_send_settings']['Insert']

export interface SendSettings {
  daily_send_limit: number
  window_start_hour: number
  window_end_hour: number
  send_on_weekends: boolean
  timezone: string
  warmup_start: number
  warmup_per_day: number
  warmup_started_at: string | null
}

export const DEFAULT_SEND_SETTINGS: SendSettings = {
  daily_send_limit: 100,
  window_start_hour: 8,
  window_end_hour: 18,
  send_on_weekends: false,
  timezone: 'Asia/Seoul',
  warmup_start: 0,
  warmup_per_day: 20,
  warmup_started_at: null,
}

const QK = 'org-send-settings'

export function useSendSettings() {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: [QK, currentOrg?.id],
    queryFn: async (): Promise<SendSettings> => {
      const { data, error } = await supabase
        .from('org_send_settings')
        .select('*')
        .eq('org_id', currentOrg!.id)
        .maybeSingle()
      if (error) throw error
      if (!data) return DEFAULT_SEND_SETTINGS
      const r = data as Row
      return {
        daily_send_limit: r.daily_send_limit,
        window_start_hour: r.window_start_hour,
        window_end_hour: r.window_end_hour,
        send_on_weekends: r.send_on_weekends,
        timezone: r.timezone,
        warmup_start: r.warmup_start,
        warmup_per_day: r.warmup_per_day,
        warmup_started_at: r.warmup_started_at,
      }
    },
    enabled: !!currentOrg,
  })
}

export function useUpdateSendSettings() {
  const { currentOrg } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (settings: SendSettings) => {
      if (!currentOrg) throw new Error('조직 정보가 필요합니다.')
      const payload: Insert = { org_id: currentOrg.id, ...settings }
      const { error } = await supabase
        .from('org_send_settings')
        .upsert(payload, { onConflict: 'org_id' })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('발송 설정을 저장했습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '발송 설정 저장 실패'),
  })
}
