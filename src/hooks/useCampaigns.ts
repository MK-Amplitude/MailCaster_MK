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
// 서버 발송 등록 — "지금 발송" 을 서버(send-scheduled-campaigns)에 위임.
// scheduled_at=now 로 예약한 뒤, 사용자 JWT 로 함수를 "즉시" 깨워 곧바로 발송 시작.
//   (매분 도는 cron 을 기다리지 않으므로 시작 지연 ~0. cron 은 재개/안전망으로 유지)
// 브라우저 탭을 닫아도 발송이 계속되고, 체크포인트/재개/중복 방지가 적용됨.
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

      // 즉시 킥 — 함수를 지금 깨워 발송 시작 (best-effort, fire-and-forget).
      // await 하지 않음: 대형 캠페인은 함수가 최대 ~50초 처리 후 응답하므로 기다리면 UI 가 멈춤.
      // 요청만 띄우고 즉시 반환 → 서버가 백그라운드로 발송. 실패/미도달해도 cron 이 1분 내 집어감.
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (accessToken) {
        void supabase.functions
          .invoke('send-scheduled-campaigns', {
            body: { campaign_id: campaignId },
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          .catch((e) => {
            console.warn('[enqueueServerSend] immediate kick failed, cron will pick up:', e)
          })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('발송을 시작했습니다 — 창을 닫아도 서버가 계속 발송합니다.', {
        duration: 7000,
      })
    },
    onError: (e: Error) => toast.error(e.message || '발송 등록 실패'),
  })
}

// ------------------------------------------------------------
// 멈춘 발송 복구/재개 — status='sending' 인데 진행이 멈춘 캠페인을 사용자가 직접 재개.
// pg_cron 이 돌지 않는 환경에서도 동작하도록 클라이언트가 함수를 직접 호출한다.
//   1) 고착 수신자('sending' + gmail_message_id NULL)를 pending 으로 되돌림
//   2) 캠페인을 scheduled + 체크포인트 초기화 (CAS: 현재 sending 인 것만)
//   3) send-scheduled-campaigns 를 사용자 JWT 로 즉시 호출 (cron 무관)
// ------------------------------------------------------------
export function useResumeCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ campaignId }: { campaignId: string }) => {
      // 1) 고착 수신자 되돌리기 (실제 발송 안 된 것만 — gmail_message_id NULL)
      const { error: rErr } = await supabase
        .from('recipients')
        .update({ status: 'pending' })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending')
        .is('gmail_message_id', null)
      if (rErr) throw rErr

      // 2) 캠페인을 scheduled 로 되돌리고 체크포인트 초기화 (sending 인 것만 — CAS)
      const { data, error } = await supabase
        .from('campaigns')
        .update({
          status: 'scheduled',
          scheduled_at: new Date().toISOString(),
          sending_started_at: null,
          last_processed_recipient_id: null,
        })
        .eq('id', campaignId)
        .eq('status', 'sending')
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('재개할 수 없는 상태입니다 (이미 완료되었거나 발송 중이 아님).')
      }

      // 3) 함수 즉시 호출 (cron 무관)
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (accessToken) {
        void supabase.functions
          .invoke('send-scheduled-campaigns', {
            body: { campaign_id: campaignId },
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          .catch((e) => console.warn('[resumeCampaign] kick failed, cron fallback:', e))
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('발송을 재개했습니다 — 곧 남은 수신자에게 발송됩니다.', { duration: 7000 })
    },
    onError: (e: Error) => toast.error(e.message || '발송 재개 실패'),
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
      // 서버(send-scheduled-campaigns)는 반송 우선으로 제외하므로 카운트도 같은 순서로:
      //   bounced = is_bounced
      //   unsubscribed = is_unsubscribed AND NOT is_bounced (반송자와 중복 집계 방지)
      const bouncedQ = supabase
        .from('recipients')
        .select('id, contacts!inner(id)', { count: 'exact', head: true })
        .eq('campaign_id', campaignId!)
        .in('status', ['pending', 'sending'])
        .is('gmail_message_id', null)
        .eq('contacts.is_bounced', true)
      const unsubQ = supabase
        .from('recipients')
        .select('id, contacts!inner(id)', { count: 'exact', head: true })
        .eq('campaign_id', campaignId!)
        .in('status', ['pending', 'sending'])
        .is('gmail_message_id', null)
        .eq('contacts.is_unsubscribed', true)
        .eq('contacts.is_bounced', false)

      const [totalRes, bouncedRes, unsubRes, emptyRes] = await Promise.all([
        base(),
        bouncedQ,
        unsubQ,
        base().or('email.is.null,email.eq.'),
      ])
      for (const r of [totalRes, bouncedRes, unsubRes, emptyRes]) {
        if (r.error) throw r.error
      }
      const target = totalRes.count ?? 0
      const bounced = bouncedRes.count ?? 0
      const unsubscribed = unsubRes.count ?? 0
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
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      const { data: result, error } = await supabase
        .from('campaigns')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ ...data, user_id: user.id, org_id: currentOrg.id } as any)
        .select()
        .single()
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
      const { error } = await supabase.from('campaigns').delete().eq('id', id)
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
