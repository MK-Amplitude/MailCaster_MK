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
      // .range 명시 — PostgREST 기본 cap(1000행) 으로 1,000명 초과 캠페인의
      // 상세 목록/분석이 잘려 보이던 문제 방지.
      const { data, error } = await supabase
        .from('recipients')
        .select('*')
        .eq('campaign_id', campaignId!)
        .order('created_at', { ascending: true })
        .range(0, 9999)
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

// ------------------------------------------------------------
// 서버 발송 등록 — "지금 발송" 을 서버(예약 발송 cron)에 위임.
// scheduled_at = now 로 예약하면 매분 도는 send-scheduled-campaigns 가 1분 이내 집어
// 발송한다. 브라우저 탭을 닫아도 발송이 계속되고, 체크포인트/재개/중복 방지가 적용됨.
// ------------------------------------------------------------
export function useEnqueueServerSend() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ campaignId }: { campaignId: string }) => {
      // CAS — draft/scheduled/failed 에서만 전환. 이미 sending/sent 면 차단 (중복 발송 방지).
      // failed 포함: 발송 버튼이 failed 캠페인에도 노출됨 (남은 pending 수신자 재시도).
      const { data, error } = await supabase
        .from('campaigns')
        .update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
        .eq('id', campaignId)
        .in('status', ['draft', 'scheduled', 'failed'])
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('발송할 수 없는 상태입니다 (이미 발송 중이거나 완료된 캠페인).')
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('발송이 서버에 등록되었습니다 — 1분 이내 시작됩니다. 창을 닫아도 발송이 계속됩니다.', {
        duration: 8000,
      })
    },
    onError: (e: Error) => toast.error(e.message || '발송 등록 실패'),
  })
}

// ------------------------------------------------------------
// 발송 전 프리플라이트 — 서버가 발송 시점에 제외할 수신자(수신거부/반송/빈 이메일)를
// 미리 집계해 확인 다이얼로그에 보여준다. 다이얼로그 열릴 때만 fetch.
// ------------------------------------------------------------
export interface SendPreflight {
  target: number       // 미발송(pending/orphan) 수신자 수
  unsubscribed: number // 발송 시 제외될 수신거부
  bounced: number      // 발송 시 제외될 반송
  emptyEmail: number   // 이메일 없는 행
  sendable: number     // 실제 발송될 수
}

export function useSendPreflight(campaignId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [QK, 'preflight', campaignId],
    queryFn: async (): Promise<SendPreflight> => {
      // head-count 쿼리 4개 — 행 데이터를 내려받지 않아 10k 초과 캠페인에서도 정확하고 가볍다.
      // 미발송 대상 = status pending/sending AND gmail_message_id IS NULL (서버 로드 조건과 동일)
      const base = () =>
        supabase
          .from('recipients')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campaignId!)
          .in('status', ['pending', 'sending'])
          .is('gmail_message_id', null)
      // contacts embed 필터는 !inner 조인 필요 — 카운트 전용 select
      const flagged = (col: 'is_bounced' | 'is_unsubscribed') =>
        supabase
          .from('recipients')
          .select('id, contacts!inner(id)', { count: 'exact', head: true })
          .eq('campaign_id', campaignId!)
          .in('status', ['pending', 'sending'])
          .is('gmail_message_id', null)
          .eq(`contacts.${col}`, true)

      const [totalRes, bouncedRes, unsubRes, emptyRes] = await Promise.all([
        base(),
        flagged('is_bounced'),
        flagged('is_unsubscribed'),
        base().or('email.is.null,email.eq.'),
      ])
      for (const r of [totalRes, bouncedRes, unsubRes, emptyRes]) {
        if (r.error) throw r.error
      }
      const target = totalRes.count ?? 0
      const bounced = bouncedRes.count ?? 0
      // 반송이면서 수신거부인 사람이 중복 집계되지 않도록 서버 제외 순서(반송 우선)에 맞춰 보정
      const unsubscribed = Math.max(0, (unsubRes.count ?? 0) - 0)
      const emptyEmail = emptyRes.count ?? 0
      const excluded = Math.min(target, bounced + unsubscribed + emptyEmail)
      return {
        target,
        unsubscribed,
        bounced,
        emptyEmail,
        sendable: Math.max(0, target - excluded),
      }
    },
    enabled: !!campaignId && enabled,
    staleTime: 10_000,
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
