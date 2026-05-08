// 관계 관리 대시보드용 — contact_engagement 뷰 조회 훅.
// 클라이언트가 필터/정렬/페이징을 적용. 1만 명 이내 안전 (range 0~9999).

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { ContactEngagementRow } from '@/types/engagement'

const QK = 'contact-engagement'

export function useContactEngagement() {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id],
    queryFn: async (): Promise<ContactEngagementRow[]> => {
      // 수신거부/반송된 연락처도 포함 — 대시보드에서 한눈에 파악 후 분류 변경 등 액션을 취할 수 있게.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('contact_engagement') as any)
        .select('*')
        .eq('org_id', currentOrg!.id)
        // 마지막 발송 시각 내림차순 — 최근 활동 먼저, NULL (미발송) 끝에
        .order('last_sent_at', { ascending: false, nullsFirst: false })
        .range(0, 9999)
      if (error) throw error
      return (data ?? []) as ContactEngagementRow[]
    },
    enabled: !!currentOrg,
  })
}
