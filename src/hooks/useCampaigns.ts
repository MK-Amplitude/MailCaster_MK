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

// ============================================================
// 수신자 추가/제거 — 발송 전(draft/scheduled) 캠페인에서 인라인 편집 용도.
// 추가 시 현재 contact 값을 스냅샷해 variables 에 저장 (CampaignWizardPage 와 동일 규칙).
// 제거 시 후속 cron 잡(send-scheduled-campaigns) 이 이미 처리한 row 만 아니면 안전.
// 추가/제거 후 campaigns.total_count 를 실시간 row 수로 다시 맞춘다.
// ============================================================

interface AddRecipientArgs {
  campaignId: string
  contact: {
    id: string
    email: string
    name: string | null
    company: string | null
    department: string | null
    job_title: string | null
    display_title?: string | null
  }
}

export function useAddRecipientToCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ campaignId, contact }: AddRecipientArgs) => {
      // 같은 이메일 중복 방지
      const normalizedEmail = contact.email.trim().toLowerCase()
      const { data: existing } = await supabase
        .from('recipients')
        .select('id')
        .eq('campaign_id', campaignId)
        .ilike('email', normalizedEmail)
        .maybeSingle()
      if (existing) {
        throw new Error('이미 이 캠페인의 수신자입니다.')
      }

      // 사용 직책 우선 — 메일 본문 {{job_title}} 가 받을 값. CampaignWizardPage 와 동일.
      const effectiveTitle = contact.display_title?.trim() || contact.job_title || null
      const variables = {
        email: contact.email,
        name: contact.name,
        company: contact.company,
        department: contact.department,
        job_title: effectiveTitle,
        job_title_raw: contact.job_title,
      }

      const { data, error } = await supabase
        .from('recipients')
        .insert({
          campaign_id: campaignId,
          contact_id: contact.id,
          email: normalizedEmail,
          name: contact.name,
          variables,
          status: 'pending',
        })
        .select()
        .single()
      if (error) throw error

      // total_count 재동기화
      await syncCampaignTotalCount(campaignId)
      return data
    },
    onSuccess: (_, { campaignId }) => {
      qc.invalidateQueries({ queryKey: [QK, 'recipients', campaignId] })
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('수신자가 추가되었습니다.')
    },
    onError: (e: Error) => {
      toast.error(e.message || '수신자 추가 실패')
    },
  })
}

export function useRemoveRecipientFromCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      recipientId,
      campaignId,
    }: {
      recipientId: string
      campaignId: string
    }) => {
      const { error } = await supabase.from('recipients').delete().eq('id', recipientId)
      if (error) throw error
      await syncCampaignTotalCount(campaignId)
    },
    onSuccess: (_, { campaignId }) => {
      qc.invalidateQueries({ queryKey: [QK, 'recipients', campaignId] })
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('수신자가 제외되었습니다.')
    },
    onError: (e: Error) => {
      toast.error(e.message || '수신자 제외 실패')
    },
  })
}

async function syncCampaignTotalCount(campaignId: string) {
  // recipients row 수를 세어 campaigns.total_count 갱신.
  const { count, error: cntErr } = await supabase
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (cntErr) {
    console.warn('[syncCampaignTotalCount] count failed:', cntErr)
    return
  }
  const { error: upErr } = await supabase
    .from('campaigns')
    .update({ total_count: count ?? 0 })
    .eq('id', campaignId)
  if (upErr) console.warn('[syncCampaignTotalCount] update failed:', upErr)
}
