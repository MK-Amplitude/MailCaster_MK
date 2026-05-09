// 관계 관리 대시보드용 — campaign_engagement 뷰 조회 훅 (migration 025).

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { CampaignEngagementRow } from '@/types/engagement'

const QK = 'campaign-engagement'

export function useCampaignEngagement() {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id],
    queryFn: async (): Promise<CampaignEngagementRow[]> => {
      // campaign_engagement 뷰는 아직 generated types 에 없어 supabase 자체를 any 로 풀어줌.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      const { data, error } = await sb
        .from('campaign_engagement')
        .select('*')
        .eq('org_id', currentOrg!.id)
        .order('last_sent_at', { ascending: false, nullsFirst: false })
        .range(0, 999)
      if (error) throw error
      return (data ?? []) as CampaignEngagementRow[]
    },
    enabled: !!currentOrg,
  })
}
