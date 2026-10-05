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
import { fetchAllPages } from '@/lib/fetchAll'

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

// "멈춘 발송" 판정 기준 (C-1) — 이보다 오래 lease(sending_started_at) 갱신이 없는 'sending'
// 캠페인만 고착으로 본다. 서버 due 쿼리의 재개 기준(90초)보다 훨씬 길다:
//   서버는 run 마다 자발적 일시정지 시 lease 를 now-85s 로 반납하고, cron 은 2분 간격이며,
//   활성 캠페인이 여럿이면 tick 마다 한 캠페인씩 라운드로빈으로 처리해 정상 서버 발송도
//   lease 가 3분 넘게 낡아 보일 수 있다. 낡은 lease 는 서버가 스스로 재개하므로, 브라우저
//   재개는 정말 죽은 발송(10분 이상 진행 없음)에만 노출한다.
// useSendCampaign 의 STUCK_LEASE_MS 와 같은 값으로 유지할 것.
export const SEND_LEASE_STALE_MS = 600_000

/** status='sending' 인데 lease(sending_started_at) 가 없거나 10분 넘게 갱신되지 않음 = 죽은 실행 */
export function isSendLeaseStale(
  c: Pick<Campaign, 'status' | 'sending_started_at'>,
  now: number = Date.now(),
): boolean {
  if (c.status !== 'sending') return false
  if (!c.sending_started_at) return true
  const t = new Date(c.sending_started_at).getTime()
  if (isNaN(t)) return true
  return now - t > SEND_LEASE_STALE_MS
}

const CAMPAIGN_POLL_MS = 5_000

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
    // 발송 중 / 곧 발송될 예약 캠페인은 서버가 상태·카운터를 바꾸므로 폴링.
    // 앱 기본 staleTime 이 5분이라 폴링이 없으면 진행률·버튼이 낡은 상태로 멈춰 보인다.
    refetchInterval: (q) => {
      const c = q.state.data as Campaign | undefined
      if (!c) return false
      if (c.status === 'sending') return CAMPAIGN_POLL_MS
      if (c.status === 'scheduled') {
        const at = c.scheduled_at ? new Date(c.scheduled_at).getTime() : NaN
        if (isNaN(at)) return false
        const until = at - Date.now()
        if (until <= 60_000) return CAMPAIGN_POLL_MS
        // 먼 예약은 폴링하지 않고 "발송 1분 전" 에 한 번 깨어나 위 분기로 진입 (최대 30분 간격).
        return Math.min(until - 60_000, 30 * 60_000)
      }
      return false
    },
  })
}

// 전체 행(개인화 override 포함)을 다시 읽으므로 너무 잦지 않게.
const RECIPIENTS_POLL_MS = 3_000

export function useCampaignRecipients(
  campaignId: string | undefined,
  // 발송 진행 중일 때만 폴링 — draft/scheduled 캠페인은 전원 pending 이라
  // "pending 있으면 폴링" 조건이 상세 페이지를 여는 내내 2초마다 최대 1만 행
  // (개인화 override 포함)을 재요청하는 트래픽 폭탄이었음.
  campaignStatus?: string,
) {
  return useQuery({
    queryKey: [QK, 'recipients', campaignId],
    queryFn: async () => {
      // PostgREST max_rows(1000) 는 .range 로도 못 넘으므로 페이지 단위로 끝까지 읽는다.
      // 배치 insert 된 행은 created_at 이 같으므로 id 로 2차 정렬해야 페이지 경계가 안정적.
      const rows = await fetchAllPages<Recipient>((from, to) =>
        supabase
          .from('recipients')
          .select('*')
          .eq('campaign_id', campaignId!)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      )
      return rows
    },
    enabled: !!campaignId,
    refetchInterval: (q) => {
      // 캠페인이 실제 발송 중(status='sending')이거나, 개별 수신자 행이
      // 'sending' 인 동안만 폴링. 그 외엔 정지. (캠페인 status 는 useCampaign 폴링으로 갱신됨)
      if (campaignStatus === 'sending') return RECIPIENTS_POLL_MS
      const c = q.state.data as Recipient[] | undefined
      if (!c) return false
      return c.some((r) => r.status === 'sending') ? RECIPIENTS_POLL_MS : false
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
        // send_attempts: 0 — 사용자가 명시적으로 재발송하는 것이므로 poison-pill
        // 카운터(075)를 리셋해 서버가 새로 5회 시도할 수 있게 한다.
        // last_error: null — 직전 실행의 중단 사유(080, D-1c)는 재등록 시점에 의미가 없어진다.
        .update({
          status: 'scheduled',
          scheduled_at: new Date().toISOString(),
          send_attempts: 0,
          last_error: null,
        })
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
// 멈춘 발송 리셋 — status='sending' 에 고착된 캠페인을 다시 보낼 수 있는 상태로 되돌린다.
//   1) 캠페인을 draft + 체크포인트 초기화 — CAS: failed, 또는 lease 가 만료된 sending 만.
//      lease 가 살아 있으면(서버가 실제로 발송 중) 0행 → 거부. 살아 있는 실행 옆에서 리셋하면
//      두 실행이 같은 수신자에게 동시에 보내 중복 발송된다.
//   2) 고착 수신자('sending' + gmail_message_id NULL)를 pending 으로 되돌림 — 1) 이 성공한 뒤에만.
// 되돌린 뒤 호출자(CampaignDetailPage)가 클라이언트 발송(useSendCampaign)을 실행한다.
//   ※ 서버 Edge Function 은 첨부 큰 캠페인에서 WORKER_RESOURCE_LIMIT(메모리 한도)로
//     죽을 수 있어, 복구 발송은 메모리 여유가 큰 브라우저(클라이언트)에서 수행한다.
// 작성자 본인만 — 브라우저 발송(useSendCampaign)은 작성자만 허용하므로, 다른 사람이 리셋하면
// 캠페인이 draft 로 주차된 채 아무것도 발송되지 않고 서버 자동 재개 대상에서도 빠진다.
// 리셋 후 발송이 시작 전에 실패하면 restoreAfterFailedResume 으로 이전 상태를 복구할 것.
// ------------------------------------------------------------
export function useResetStuckCampaign() {
  const qc = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async ({ campaignId }: { campaignId: string }) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      const { data: cur, error: curErr } = await supabase
        .from('campaigns')
        .select('user_id')
        .eq('id', campaignId)
        .maybeSingle()
      if (curErr) throw curErr
      if (!cur || cur.user_id !== user.id) {
        throw new Error(
          '발송 재개는 캠페인 작성자 본인만 할 수 있습니다. 관리자는 "발송하기"(서버 발송)를 이용해주세요.',
        )
      }

      const staleIso = new Date(Date.now() - SEND_LEASE_STALE_MS).toISOString()
      const { data, error } = await supabase
        .from('campaigns')
        .update({
          status: 'draft',
          scheduled_at: null,
          sending_started_at: null,
          last_processed_recipient_id: null,
          send_attempts: 0,
          last_error: null,
        })
        .eq('id', campaignId)
        // 소유자 CAS — 위 확인과 이 UPDATE 사이에 무엇이 바뀌어도 작성자 본인 행만 리셋
        .eq('user_id', user.id)
        .or(
          `status.eq.failed,and(status.eq.sending,sending_started_at.is.null),and(status.eq.sending,sending_started_at.lt.${staleIso})`,
        )
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error(
          '재개할 수 없는 상태입니다 — 서버가 아직 발송 중이거나(최근 10분 내 진행 — 서버가 자동으로 이어서 발송합니다), 이미 완료된 캠페인입니다.',
        )
      }

      // 고착 수신자('sending' + gmail_message_id NULL) = 죽은 실행이 Gmail 호출 직전/도중에 멈춘 행.
      // Gmail 이 이미 받았는지 알 수 없으므로(C-5) pending 으로 되돌리면 재개 시 중복 발송된다 —
      // failed + 확인 안내로 박제하고, 사용자가 보낸편지함 확인 후 개별 재발송하게 한다.
      const { error: rErr } = await supabase
        .from('recipients')
        .update({ status: 'failed', error_message: AMBIGUOUS_SEND_MESSAGE })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending')
        .is('gmail_message_id', null)
      if (rErr) throw rErr
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.error(e.message || '발송 재개 준비 실패', { duration: 10000 })
    },
  })
}

// 결과 불명 발송의 수신자 error_message — send-scheduled-campaigns / src/lib/gmail.ts 와 동일 문구 (C-5).
const AMBIGUOUS_SEND_MESSAGE = '전송 결과 불확실 — Gmail 보낸편지함 확인 후 필요 시 개별 재발송'

/**
 * useResetStuckCampaign 직후의 브라우저 발송(useSendCampaign)이 한 통도 보내지 못하고 실패했을 때
 * 리셋 전 상태로 되돌린다 — draft 로 주차된 채 남으면 cron 이 다시 집지 않아 발송이 멈춘다.
 *   · 'sending' 이었으면 'sending' + lease NULL 로 복구 → 서버 due 쿼리가 다음 tick 에 바로 재개.
 *   · 'failed' 였으면 'failed' 로 복구 (재발송 버튼 유지).
 * CAS: 작성자 본인 + status='draft' + sending_started_at NULL 일 때만. 발송 훅이 lock 을 잡았다가
 * 0통으로 롤백하면 같은 조건(draft + NULL)이 되고, 한 통이라도 보냈으면 'failed' 라 건드리지 않는다.
 * best-effort — 실패해도 throw 하지 않고 false.
 */
export async function restoreAfterFailedResume(
  campaignId: string,
  userId: string,
  previousStatus: CampaignStatus,
): Promise<boolean> {
  if (previousStatus !== 'sending' && previousStatus !== 'failed') return false
  const { data, error } = await supabase
    .from('campaigns')
    .update({ status: previousStatus, sending_started_at: null })
    .eq('id', campaignId)
    .eq('user_id', userId)
    .eq('status', 'draft')
    .is('sending_started_at', null)
    .select('id')
  if (error) {
    console.warn('[restoreAfterFailedResume] failed:', error.message)
    return false
  }
  return !!data && data.length > 0
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

export class CampaignStatusConflictError extends Error {
  constructor(message?: string) {
    super(message || '캠페인 상태가 바뀌었습니다 (이미 발송이 시작되었거나 완료됨). 새로고침 후 다시 확인해주세요.')
    this.name = 'CampaignStatusConflictError'
  }
}

/**
 * campaigns UPDATE + 상태 CAS. expectStatus 를 주면 현재 status 가 그 중 하나일 때만 갱신하고,
 * 0행이면 CampaignStatusConflictError — 서버 cron 이 막 발송을 시작한 캠페인을 낡은 화면에서
 * 덮어쓰는 것을 막는다.
 */
export async function updateCampaignCas(
  id: string,
  data: CampaignUpdate,
  expectStatus?: CampaignStatus[],
  conflictMessage?: string,
): Promise<void> {
  if (!expectStatus) {
    const { error } = await supabase.from('campaigns').update(data).eq('id', id)
    if (error) throw error
    return
  }
  const { data: rows, error } = await supabase
    .from('campaigns')
    .update(data)
    .eq('id', id)
    .in('status', expectStatus)
    .select('id')
  if (error) throw error
  if (!rows || rows.length === 0) throw new CampaignStatusConflictError(conflictMessage)
}

export function useUpdateCampaign() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({
      id,
      data,
      expectStatus,
      conflictMessage,
    }: {
      id: string
      data: CampaignUpdate
      /** 지정 시 현재 status 가 이 중 하나일 때만 갱신 (CAS) */
      expectStatus?: CampaignStatus[]
      /** CAS 실패(0행) 시 보여줄 문구 */
      conflictMessage?: string
    }) => {
      await updateCampaignCas(id, data, expectStatus, conflictMessage)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
    },
    onError: (e: Error) => {
      console.error('[updateCampaign] failed:', e)
      // 상태 충돌이면 화면의 낡은 status 를 즉시 갱신
      if (e instanceof CampaignStatusConflictError) qc.invalidateQueries({ queryKey: [QK] })
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
