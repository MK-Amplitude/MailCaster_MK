import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type {
  Campaign,
  CampaignInsert,
  CampaignUpdate,
  CampaignStatus,
  Recipient,
} from '@/types/campaign'
import { toast } from 'sonner'

const QK = 'campaigns'

// 캠페인 범위:
//   'mine' = 내가 만든 캠페인만
//   'org'  = 조직 전체 캠페인 (협업 / 발송 현황 공유)
export type CampaignScope = 'mine' | 'org'

export function useCampaigns(
  status?: CampaignStatus | 'all',
  scope: CampaignScope = 'org',
) {
  const { user, currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id, scope, status ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('campaigns')
        .select('*, profiles:user_id(email, display_name)')
        .eq('org_id', currentOrg!.id)
        .order('created_at', { ascending: false })

      if (scope === 'mine') {
        query = query.eq('user_id', user!.id)
      }

      if (status && status !== 'all') {
        query = query.eq('status', status)
      }

      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as unknown as Campaign[]
    },
    enabled: !!user && !!currentOrg,
  })
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: [QK, 'detail', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as Campaign
    },
    enabled: !!id,
  })
}

export function useCampaignRecipients(campaignId: string | undefined) {
  return useQuery({
    queryKey: [QK, 'recipients', campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('recipients')
        .select('*')
        .eq('campaign_id', campaignId!)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data ?? []) as Recipient[]
    },
    enabled: !!campaignId,
    refetchInterval: (q) => {
      const c = q.state.data as Recipient[] | undefined
      if (!c) return false
      const hasPending = c.some((r) => r.status === 'pending' || r.status === 'sending')
      return hasPending ? 2000 : false
    },
  })
}

export function useCreateCampaign() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<CampaignInsert, 'user_id' | 'org_id'>) => {
      console.log('[createCampaign] start', { data, userId: user?.id, orgId: currentOrg?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      const { data: result, error } = await supabase
        .from('campaigns')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ ...data, user_id: user.id, org_id: currentOrg.id } as any)
        .select()
        .single()
      console.log('[createCampaign] result', { result, error })
      if (error) throw error
      return result as Campaign
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
    },
    onError: (e: Error) => {
      console.error('[createCampaign] failed:', e)
      toast.error(e.message || '메일 발송 생성 실패')
    },
  })
}

export function useUpdateCampaign() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: CampaignUpdate }) => {
      const { error } = await supabase.from('campaigns').update(data).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
    },
    onError: (e: Error) => {
      console.error('[updateCampaign] failed:', e)
      toast.error(e.message || '메일 발송 수정 실패')
    },
  })
}

export function useDeleteCampaign() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      console.log('[deleteCampaign] start', { id })
      const { error } = await supabase.from('campaigns').delete().eq('id', id)
      console.log('[deleteCampaign] result', { error })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('메일 발송이 삭제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteCampaign] failed:', e)
      toast.error(e.message || '메일 발송 삭제 실패')
    },
  })
}
