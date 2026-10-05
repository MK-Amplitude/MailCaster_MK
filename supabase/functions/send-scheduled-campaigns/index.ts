// Supabase Edge Function: send-scheduled-campaigns
// pg_cron 이 매 분마다 호출. status='scheduled' AND scheduled_at<=now() 인 캠페인을
// 자동으로 발송한다.
//
// ------------------------------------------------------------
// 지원 범위 (v2 — Phase 5)
// ------------------------------------------------------------
//   개별 발송 (send_mode='individual') — 수신자별 루프, 개인화 변수 치환
//   일괄 발송 (send_mode='bulk')       — 1회 Gmail 호출, 수신자 전원 To 에 노출
//   Cc / Bcc — 캠페인 레벨 캠페인.cc, 캠페인.bcc 를 모든 메일에 동일 적용
//   본문 — campaign.body_html 를 진실의 원천(WYSIWYG). 비어있을 때만 blocks+서명에서 재조합
//   ★ 첨부 파일 (v2) — Drive 에서 직접 다운로드/공유 후 MIME 에 포함
//     - (첨부 원본 합계 + inline 이미지) 가 ATTACHMENT_SAFE_THRESHOLD 이하면 multipart/mixed 로 첨부
//     - 초과하면 자동 link 모드로 전환, Google 문서류는 항상 link
//       → 본문에 Drive 공유 링크 섹션을 append
//
// ------------------------------------------------------------
// 보안
// ------------------------------------------------------------
//   Authorization: Bearer <CRON_SECRET>  (pg_cron 주입)
//   profiles.google_refresh_token — service_role 로만 접근 가능
//
// ------------------------------------------------------------
// 락킹
// ------------------------------------------------------------
//   같은 분에 cron 이 중복 호출되더라도 campaign.status='sending' 으로 먼저
//   바꾼 쪽이 이긴다 (update 결과가 1건이면 '획득'). 나머지는 skip.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { isCronAuthorized } from '../_shared/cronAuth.ts'
import { decryptToken } from '../_shared/tokenCrypto.ts'
import { wrapLinksForClickTracking } from '../_shared/clickLinks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
// 클릭 링크 서명 전용 키 (track-click 과 동일 우선순위) — 미설정 시 CRON_SECRET 폴백
const CLICK_SIGNING_SECRET =
  Deno.env.get('CLICK_SIGNING_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
// 수신거부 안내 페이지(SPA, GitHub Pages) — 본문 footer 링크가 가리키는 곳.
// Supabase 는 *.supabase.co 의 text/html 을 text/plain 으로 내려보내 사람용 페이지를 둘 수 없다.
// (List-Unsubscribe 헤더는 RFC 8058 one-click POST 용으로 Edge Function 을 직접 가리킨다.)
// D-3 — 미설정/빈 값/공백이면 운영 기본값 (빈 base 로 상대 링크가 나가면 안 됨).
const DEFAULT_APP_BASE_URL = 'https://mk-amplitude.github.io/MailCaster_MK'
const APP_BASE_URL =
  (Deno.env.get('APP_BASE_URL') ?? '').trim().replace(/\/+$/, '') || DEFAULT_APP_BASE_URL

// 한 번 실행 시 처리할 최대 캠페인 수 — 55초 타임아웃 대비 보수적으로
const MAX_CAMPAIGNS_PER_RUN = 10

// ------------------------------------------------------------
// Phase 6 (A) — 한 run 당 쓸 수 있는 최대 시간 (ms).
// pg_cron 이 매 분 호출하고 timeout_milliseconds=55000 으로 끊는다.
// 50초를 예산으로 두고, 이걸 넘어서면 체크포인트 저장 후 즉시 종료 →
// 다음 tick 에서 이어서 처리. (send_delay_seconds × recipient 가 크면
// 예전에는 도중에 끊겨 캠페인이 'sending' 으로 stuck 됐음.)
// ------------------------------------------------------------
const RUN_BUDGET_MS = 50_000

// 남은 run 예산이 이보다 적으면 다음 캠페인의 락을 잡지 않는다.
// 락을 잡으면 send_attempts 가 오르는데, 셋업(수신자/토큰/첨부 로드)만 하고 0건 발송으로
// pause 하는 run 이 반복되면 poison-pill 로 죽는다 (#13 기아).
const MIN_BUDGET_TO_START_MS = 15_000

// 락 시점 남은 예산이 (RUN_BUDGET_MS - 이 값) 이상이고 이 invocation 의 첫 캠페인이면
// "전체 예산을 받은 run". 전체 예산을 받지 못한 run 이 0건 발송으로 자발적 pause 하면
// poison-pill 시도로 세지 않는다 (send_attempts 환불) — 예산 부족은 캠페인 결함이 아님.
const FULL_BUDGET_SLACK_MS = 5_000

// 서버 경로의 발송 간격 상한. cron 은 2분마다 1 tick, 1 run 예산은 50초라
// 간격이 30초를 넘으면 run 당 1통만 보내고 끝나 처리량이 사실상 0 에 수렴한다.
const MAX_SERVER_DELAY_SECONDS = 30

// 재개 대상 판정 기준 — sending_started_at 이 이보다 오래되면 죽은 실행으로 보고 재개.
const LEASE_STALE_MS = 90_000
// 자발적 pause(예산 소진) 로 run 을 끝낼 때 lease 를 "반납" — sending_started_at 을
// now()-85초로 CAS 기록한다. 다음 cron tick(~70초 뒤) 에는 이미 90초 경과로 보여 곧바로 재개.
// (heartbeat 를 그대로 두면 다음 tick 에선 ~70초라 skip → 한 tick 걸러 재개, 처리량 절반.)
// UI 는 180초 기준으로 "중단됨" 을 판정하므로 반납 후에도 '서버에서 발송 중' 으로 보인다.
const LEASE_RELEASE_BACKDATE_MS = 85_000

// 전송 결과 불확실(요청 송신 후 네트워크 오류/타임아웃) — 재시도·pending 복귀 금지 (중복 발송 방지).
const UNCERTAIN_SEND_MESSAGE = '전송 결과 불확실 — Gmail 보낸편지함 확인 후 필요 시 개별 재발송'

// campaigns.last_error (080) 에 남기는 사유 길이 상한 — UI 표시용 짧은 문구.
const LAST_ERROR_MAX_CHARS = 300

// 첨부 vs Drive 링크 결정 기준 — 원본 바이트 합계 (일반 첨부 + 본문 inline 이미지).
// base64 후 ~20.5MB 라 Gmail 25MB 한도 안에 본문 여유가 남는다.
// 클라이언트/UI 도 같은 15MB 를 사용한다 (경로별로 첨부/링크가 달라지면 안 됨).
const ATTACHMENT_SAFE_THRESHOLD = 15 * 1024 * 1024

// messages.send JSON({raw}) 엔드포인트는 요청 크기 한도가 작다 (~5MB).
// raw(base64url) 가 이보다 크면 /upload 엔드포인트(message/rfc822, 최대 35MB) 로 보낸다.
const GMAIL_JSON_RAW_MAX_CHARS = Math.floor(4.5 * 1024 * 1024)

// Gmail 일시 오류(429/5xx) 재시도 — run 예산 안에서만.
const GMAIL_MAX_RETRIES = 3
const GMAIL_RETRY_BASE_MS = 1_000
const GMAIL_RETRY_MAX_WAIT_MS = 8_000

// 할당량/레이트리밋으로 중단할 때 다음 재개 시각
const QUOTA_RESCHEDULE_MS = 6 * 60 * 60 * 1000
const RATE_RESCHEDULE_MS = 15 * 60 * 1000
const MAX_RESCHEDULE_MS = 24 * 60 * 60 * 1000

// PostgREST URL 길이 한도 대비 .in('id', …) 청크 크기
const ID_CHUNK = 100

// supabase-js 클라이언트 (Edge 에서는 생성 타입을 쓰지 않음)
// deno-lint-ignore no-explicit-any
type Db = any // eslint-disable-line @typescript-eslint/no-explicit-any

// 분류된 오류 — transient 는 캠페인을 failed 로 내리지 않고 다음 tick 에 재시도.
//   ambiguous — 요청을 보낸 뒤 결과를 모름(네트워크 오류/타임아웃). Gmail 이 이미 발송했을 수
//               있으므로 재시도/pending 복귀 금지 → 해당 수신자만 '결과 불확실' failed.
//   fatal     — 계정 전체 오류(재인증 실패 401, 권한/도메인 정책 403, Gmail 미사용 400 등).
//               다음 수신자도 똑같이 실패하므로 run 전체를 멈추고 캠페인을 failed 로.
type GmailErrorKind = 'quota' | 'rate' | 'transient' | 'ambiguous' | 'fatal' | 'permanent'
type TaggedError = Error & {
  status?: number
  transient?: boolean
  kind?: GmailErrorKind
  retryAt?: number | null
  // 연결 수립 단계 실패(요청 미송신 확정) — 발송되지 않았으므로 pending 복귀는 안전하지만
  // run 안 재시도는 하지 않는다 (재시도는 Gmail 이 실제로 돌려준 429/5xx 에만).
  preSend?: boolean
}

function fatalError(message: string, status?: number): TaggedError {
  const err = new Error(message) as TaggedError
  err.kind = 'fatal'
  if (status != null) err.status = status
  return err
}

function transientError(message: string): TaggedError {
  const err = new Error(message) as TaggedError
  err.transient = true
  return err
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

// 이 run 이 쥔 lease (= campaigns.sending_started_at 값). 모든 캠페인 쓰기는 이 값으로 CAS.
interface LeaseRef {
  token: string | null
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Recipient {
  id: string
  email: string
  name: string | null
  variables: Record<string, unknown> | null
  subject_override: string | null
  body_html_override: string | null
  // 079 — 수신거부 링크 / List-Unsubscribe 토큰 (마이그레이션 전 행 호환 위해 nullable 취급)
  unsubscribe_token: string | null
}

interface Campaign {
  id: string
  user_id: string
  org_id: string | null
  name: string
  subject: string | null
  body_html: string | null
  signature_id: string | null
  send_delay_seconds: number | null
  cc: string[] | null
  bcc: string[] | null
  send_mode: string | null
  scheduled_at: string | null
  status: string
  // Phase 6 (A) — 체크포인트
  sending_started_at: string | null
  last_processed_recipient_id: string | null
  // Phase 6 (C) — 오픈 추적 on/off
  enable_open_tracking: boolean | null
  // 069 — 발송 완료 후 수신자를 등록할 후속 시퀀스
  followup_sequence_id: string | null
  // 075 — 서버 발송 락 획득 횟수 (poison-pill 가드)
  send_attempts: number | null
  // 001 컬럼 (079 부터 사용) — false 가 아니면 수신거부 footer + List-Unsubscribe 헤더
  include_unsubscribe_link: boolean | null
}

// 075 — 크래시 루프 차단: "진전 없는" 연속 run 이 이 값에 닿으면 failed 로 내린다.
// 락 시점에 +1 (이후 WORKER_RESOURCE_LIMIT 크래시에도 카운트가 남음) 하고,
// 수신자를 1명이라도 처리(sent/failed)한 run 은 0 으로 되돌린다 — 정상 진행 중인
// 대형 캠페인이 resume 횟수만으로 죽지 않도록.
const MAX_SEND_ATTEMPTS = 5

interface DriveAttachmentRow {
  id: string
  drive_file_id: string
  file_name: string
  file_size: number | null
  mime_type: string | null
  web_view_link: string | null
  is_public_shared: boolean | null
}

interface PreparedAttachment {
  id: string
  filename: string
  mimeType: string
  size: number | null
  // 파일별 전달 방식 — Google 문서류는 다운로드 불가라 항상 link
  mode: 'attachment' | 'link'
  // attachment 모드에서만 채움 — run 당 1회 인코딩한 base64 ASCII 바이트, 76자 줄바꿈 완료
  wrapped?: Uint8Array
  // link 모드에서만 채움
  link?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // CRON_SECRET 은 cron(배치) 경로에만 필요. 사용자 JWT 경로("지금 발송"/"발송 재개")는
  // CRON_SECRET 미설정이어도 동작해야 하므로 여기서 전역 차단하지 않는다.
  const auth = req.headers.get('Authorization') ?? ''
  const isCron = isCronAuthorized(auth, CRON_SECRET)

  // 인증 2경로:
  //   1) pg_cron — Bearer CRON_SECRET. 도래한/재개 대상 캠페인 전체를 배치 처리.
  //   2) 사용자 JWT — "지금 발송" 버튼이 특정 campaign_id 를 즉시 깨울 때.
  //      매분 도는 cron 을 기다리지 않고 곧바로 발송 시작 (시작 지연 ~0).
  //      RLS 로 소유/조직 검증 — 사용자가 SELECT 할 수 있는 캠페인만 처리.
  let userCampaignId: string | null = null
  if (!isCron) {
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return json({ error: 'unauthorized' }, 401)
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await authClient.auth.getUser()
    if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401)
    let body: { campaign_id?: string } = {}
    try {
      body = await req.json()
    } catch { /* 빈 본문 */ }
    if (!body.campaign_id) {
      return json({ error: '사용자 발송에는 campaign_id 가 필요합니다.' }, 400)
    }
    // 소유권 검증 — SELECT 가시성(조직 멤버 전체)이 아니라 "소유자 또는 org admin"
    // 만 발송을 트리거할 수 있어야 한다. 가시성 기준이면 일반 멤버가 동료 캠페인을
    // 예약 시각 전에 강제 발송시킬 수 있음.
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: campRow } = await svc
      .schema('mailcaster')
      .from('campaigns')
      .select('id, user_id, org_id')
      .eq('id', body.campaign_id)
      .maybeSingle()
    if (!campRow) return json({ error: '해당 캠페인에 대한 권한이 없습니다.' }, 403)
    let allowed = campRow.user_id === userData.user.id
    if (!allowed) {
      const { data: adminRow } = await svc
        .schema('mailcaster')
        .from('org_members')
        .select('role')
        .eq('org_id', campRow.org_id)
        .eq('user_id', userData.user.id)
        .in('role', ['owner', 'admin'])
        .maybeSingle()
      allowed = !!adminRow
    }
    if (!allowed) return json({ error: '해당 캠페인에 대한 권한이 없습니다.' }, 403)
    userCampaignId = body.campaign_id
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const runStartedAt = Date.now()

  try {
    // ------------------------------------------------------------
    // 1) 처리 대상 캠페인 조회
    //    Phase 6 (A) — status='sending' 이며 체크포인트(sending_started_at) 가
    //    기록된 캠페인도 재개 대상으로 함께 집는다. 'scheduled' 는 종전처럼 도래한 것만.
    //
    // 'sending' 인데 체크포인트가 없는 건 "방금 락 획득한 동시 실행" 이거나
    // 클라이언트 즉시 발송 중 케이스이므로 cron 이 건드리지 않는다.
    // ------------------------------------------------------------
    const nowIso = new Date().toISOString()
    // 재개 대상은 lease 만료된 것만 — sending_started_at 이 90초 이내면
    // 아직 살아있는(또는 방금 죽은) 실행일 수 있으므로 건드리지 않는다.
    // 락 획득/재개 시 sending_started_at 을 항상 새로 찍으므로 (아래 processCampaign),
    // 살아있는 실행과 겹쳐 같은 수신자에게 중복 발송되는 경쟁을 차단한다.
    // 자발적 pause 로 끝난 run 은 lease 를 now()-85초로 반납하므로 다음 tick 에 바로 집힌다.
    const staleIso = new Date(Date.now() - LEASE_STALE_MS).toISOString()
    const COLS =
      'id, user_id, org_id, name, subject, body_html, signature_id, send_delay_seconds, cc, bcc, send_mode, scheduled_at, status, sending_started_at, last_processed_recipient_id, enable_open_tracking, followup_sequence_id, send_attempts, include_unsubscribe_link'

    // 사용자 즉시 발송 경로 — 해당 campaign_id 하나만 (scheduled 또는 lease 만료된 sending).
    // 실제 발송 여부는 processCampaign 의 CAS 락이 최종 판정 (cron 과 겹쳐도 1회만).
    // 재개/복구 대상:
    //   · status='sending' + sending_started_at 90초 경과 (lease 만료 — 죽은 실행)
    //   · status='sending' + sending_started_at IS NULL (체크포인트 없이 고착된 레거시)
    const dueQuery = userCampaignId
      ? supabase.schema('mailcaster').from('campaigns').select(COLS)
          .eq('id', userCampaignId)
          .or(`status.eq.scheduled,and(status.eq.sending,sending_started_at.lt.${staleIso}),and(status.eq.sending,sending_started_at.is.null)`)
      : supabase.schema('mailcaster').from('campaigns').select(COLS)
          .or(
            `and(status.eq.scheduled,scheduled_at.lte.${nowIso}),and(status.eq.sending,sending_started_at.lt.${staleIso}),and(status.eq.sending,sending_started_at.is.null)`
          )
          // 신규/고착(lease NULL) 먼저, 그 다음 가장 오래 기다린 재개 순 — 대형 캠페인 하나가
          // 매 tick 첫 순번을 독점해 다른 캠페인이 굶는 것 방지 (lease 시각 기준 라운드로빈).
          .order('sending_started_at', { ascending: true, nullsFirst: true })
          .order('scheduled_at', { ascending: true })
          .limit(MAX_CAMPAIGNS_PER_RUN)

    const { data: due, error: dErr } = await dueQuery

    if (dErr) throw dErr
    if (!due || due.length === 0) {
      return json({ processed: 0, sent: 0, failed: 0, message: 'no due campaigns' })
    }

    let totalSent = 0
    let totalFailed = 0
    const perCampaign: Array<{
      id: string
      sent: number
      failed: number
      paused?: boolean
      error?: string
    }> = []

    for (const c of due as Campaign[]) {
      // 런 예산이 셋업 + 최소 1통 발송에 못 미치면 이 tick 에서는 추가 캠페인에 손대지 않는다.
      // (락을 잡으면 send_attempts 가 오르므로 0건 발송 run 을 만들지 않는 게 중요)
      // 아직 처리하지 않은 캠페인은 status 그대로 두므로 다음 cron 에서 자연스럽게 집힌다.
      if (RUN_BUDGET_MS - (Date.now() - runStartedAt) < MIN_BUDGET_TO_START_MS) {
        console.log(
          `[send-scheduled] run budget low — deferring ${due.length - perCampaign.length} campaigns to next tick`
        )
        break
      }
      const lease: LeaseRef = { token: null }
      // 이 invocation 에서 처음 처리하는 캠페인인지 — poison-pill 환불 판정용 (FULL_BUDGET_SLACK_MS)
      const firstInRun = perCampaign.length === 0
      try {
        const r = await processCampaign(supabase, c, runStartedAt, lease, firstInRun)
        if (r.error) console.error(`[send-scheduled] campaign ${c.id} stopped:`, r.error)
        totalSent += r.sent
        totalFailed += r.failed
        perCampaign.push({ id: c.id, ...r })
      } catch (e) {
        const msg = errMessage(e)
        perCampaign.push({ id: c.id, sent: 0, failed: 0, error: msg })
        if ((e as TaggedError)?.transient) {
          // 일시 오류(Drive/OAuth/DB 429·5xx 등) — failed 로 내리지 않는다. lease 가 만료되면
          // 다음 tick 이 재개. 진전 없는 run 이 반복되면 send_attempts 로 결국 차단됨.
          console.warn(`[send-scheduled] campaign ${c.id} transient error — retry next tick:`, msg)
          continue
        }
        console.error(`[send-scheduled] campaign ${c.id} fatal:`, msg)
        // 락을 못 잡은 상태의 오류면 이 run 소유가 아니므로 상태를 건드리지 않는다.
        if (!lease.token) continue
        // W7) 캠페인 상태를 failed 로 전환하고 체크포인트를 리셋한다.
        //     체크포인트가 남아 있으면 관리자/사용자가 수동으로 "재발송" 할 때
        //     재개 경로 (status='sending' + sending_started_at IS NOT NULL) 에
        //     오진입할 수 있어 혼란이 생김.
        //     failed 로 내려가는 즉시 sending_started_at / last_processed_recipient_id 를
        //     NULL 로 되돌려 깨끗한 재발송을 보장.
        //     lease CAS — 그 사이 다른 실행(브라우저 발송 등)이 가져갔다면 덮어쓰지 않는다.
        await supabase
          .schema('mailcaster')
          .from('campaigns')
          .update({
            status: 'failed',
            sending_started_at: null,
            last_processed_recipient_id: null,
            send_attempts: 0,
            last_error: shortReason(`발송 실패 — ${msg}`),
          })
          .eq('id', c.id)
          .eq('status', 'sending')
          .eq('sending_started_at', lease.token)
      }
    }

    return json({
      processed: perCampaign.length,
      sent: totalSent,
      failed: totalFailed,
      campaigns: perCampaign,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[send-scheduled] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

// ------------------------------------------------------------
// 개별 캠페인 처리
// ------------------------------------------------------------
async function processCampaign(
  supabase: Db,
  c: Campaign,
  runStartedAt: number,
  lease: LeaseRef,
  firstInRun: boolean,
): Promise<{ sent: number; failed: number; paused?: boolean; rescheduled?: string; error?: string }> {
  // 1) 락 획득
  //    Phase 6 (A) — 두 가지 진입 경로 지원:
  //      a) 신규 발송: status='scheduled' → 'sending' + sending_started_at=NOW()
  //      b) 재개 발송: status='sending' 이며 sending_started_at 이 이미 있는 경우
  //         (다른 cron 이 동시에 집는 걸 막기 위해 sending_started_at 값을 조건에 걸어 CAS)
  //
  //    어느 쪽이든 UPDATE 결과가 1건일 때만 "이 run 이 소유" 한다.
  //    이 run 이 쓴 sending_started_at 값이 lease 토큰 — 이후 모든 캠페인 쓰기는 이 값으로 CAS 하고
  //    매번 새 값으로 갱신한다. CAS 가 0건이면 다른 실행(브라우저 발송·취소 등)이 가져간 것.
  //
  //    075 — poison-pill 가드: 진전 없는 연속 run 이 상한을 넘으면 이 캠페인은
  //    처리 불가능(예: 첨부 과대 → WORKER_RESOURCE_LIMIT 크래시 루프)으로 보고
  //    failed 로 내려 루프를 끊는다. 사용자는 UI 에서 클라이언트 발송으로 재개 가능.
  const attempts = c.send_attempts ?? 0
  if (attempts >= MAX_SEND_ATTEMPTS) {
    console.error(
      `[send-scheduled] campaign ${c.id} exceeded ${MAX_SEND_ATTEMPTS} send attempts without progress — marking failed (poison pill)`,
    )
    // CAS — due 조회 시점의 status / sending_started_at 그대로일 때만. 그 사이 브라우저 재개 등
    // 다른 실행이 lease 를 가져갔다면 살아있는 발송을 failed 로 덮어쓰지 않는다.
    let q = supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({
        status: 'failed',
        scheduled_at: null,
        sending_started_at: null,
        last_processed_recipient_id: null,
        send_attempts: 0,
        last_error: shortReason(
          `서버 발송이 ${MAX_SEND_ATTEMPTS}회 연속 진전 없이 중단되어 실패 처리했습니다 — 첨부 용량을 줄이거나 브라우저에서 발송을 재개해 주세요.`,
        ),
      })
      .eq('id', c.id)
      .eq('status', c.status)
    q = c.sending_started_at
      ? q.eq('sending_started_at', c.sending_started_at)
      : q.is('sending_started_at', null)
    const { error: ppErr } = await q
    if (ppErr) console.error(`[send-scheduled] campaign ${c.id} poison-pill update failed:`, ppErr.message)
    return { sent: 0, failed: 0 }
  }

  if (c.status === 'scheduled') {
    const lockAt = new Date().toISOString()
    const { data: locked, error: lockErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({
        status: 'sending',
        sending_started_at: lockAt,
        send_attempts: attempts + 1,
      })
      .eq('id', c.id)
      .eq('status', 'scheduled')
      .select('id, sending_started_at')
    if (lockErr) throw lockErr
    if (!locked || locked.length === 0) {
      console.log(`[send-scheduled] campaign ${c.id} already picked up — skip`)
      return { sent: 0, failed: 0 }
    }
    lease.token = lockAt
  } else if (c.status === 'sending' && c.sending_started_at) {
    // 재개: sending_started_at 의 현재 값을 CAS 토큰으로 걸되, 반드시 "새 값" 을 쓴다.
    // 같은 값을 다시 쓰면 두 동시 실행 모두 predicate 를 통과해 둘 다 락을 얻는
    // (→ 중복 발송) 문제가 있었음. 새 timestamp 를 쓰면 두 번째 실행의
    // .eq(old value) 가 더 이상 매칭되지 않아 진짜 CAS 가 된다.
    // 이 갱신은 SELECT 의 90초 lease 기준 시각도 함께 연장한다.
    const lockAt = nextLeaseValue(c.sending_started_at)
    const { data: touched, error: lockErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ sending_started_at: lockAt, send_attempts: attempts + 1 })
      .eq('id', c.id)
      .eq('status', 'sending')
      .eq('sending_started_at', c.sending_started_at)
      .select('id')
    if (lockErr) throw lockErr
    if (!touched || touched.length === 0) {
      console.log(`[send-scheduled] campaign ${c.id} resume raced — skip`)
      return { sent: 0, failed: 0 }
    }
    lease.token = lockAt
    console.log(`[send-scheduled] campaign ${c.id} resuming from checkpoint`)
  } else if (c.status === 'sending') {
    // 체크포인트 없이 'sending' 에 고착된 캠페인 복구 —
    // 옛 클라이언트 발송이 탭 종료 등으로 중간에 끊긴 레거시 상태.
    // (현재는 모든 발송이 서버 경로라 sending 전환 시 sending_started_at 을 항상 원자적으로
    //  같이 찍으므로, sending_started_at=NULL 인 sending 은 정의상 "죽은/고착된" 실행이다.)
    // sending_started_at IS NULL 을 CAS 토큰으로 걸어 한 run 만 소유하도록 한다.
    const lockAt = new Date().toISOString()
    const { data: recovered, error: lockErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ sending_started_at: lockAt, send_attempts: attempts + 1 })
      .eq('id', c.id)
      .eq('status', 'sending')
      .is('sending_started_at', null)
      .select('id')
    if (lockErr) throw lockErr
    if (!recovered || recovered.length === 0) {
      console.log(`[send-scheduled] campaign ${c.id} recover raced — skip`)
      return { sent: 0, failed: 0 }
    }
    lease.token = lockAt
    console.log(`[send-scheduled] campaign ${c.id} recovering stuck 'sending' (no checkpoint)`)
  } else {
    // 그 외 예상 못한 상태 — 안전하게 skip
    console.log(`[send-scheduled] campaign ${c.id} unexpected state — skip`)
    return { sent: 0, failed: 0 }
  }

  // 이 run 이 전체 예산을 받았는지 (락 시점 기준). 아니면 0건 발송 자발적 pause 시
  // send_attempts 를 락 이전 값으로 환불한다 — 앞선 캠페인이 예산을 써서 굶은 것이지
  // 이 캠페인이 처리 불가능(poison)한 게 아님. 전체 예산을 받고도 0건이면 그대로 센다.
  const hadFullBudget =
    firstInRun && RUN_BUDGET_MS - (Date.now() - runStartedAt) >= RUN_BUDGET_MS - FULL_BUDGET_SLACK_MS
  const starvedRefund = (): Record<string, unknown> =>
    hadFullBudget ? {} : { send_attempts: attempts }

  // lease 연장 + 소유 확인 (CAS). 'lost' = 다른 실행이 가져감/취소됨 → 즉시 중단.
  // 'error' = 소유 여부를 확인 못 함 → 안전하게 중단 (lease 만료 후 다음 tick 이 재개).
  async function touchLease(extra: Record<string, unknown> = {}): Promise<'ok' | 'lost' | 'error'> {
    const prev = lease.token
    if (!prev) return 'lost'
    const next = nextLeaseValue(prev)
    const { data, error } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ ...extra, sending_started_at: next })
      .eq('id', c.id)
      .eq('status', 'sending')
      .eq('sending_started_at', prev)
      .select('id')
    if (error) {
      console.error(`[send-scheduled] campaign ${c.id} lease refresh failed:`, error.message)
      return 'error'
    }
    if (!data || data.length === 0) {
      console.warn(`[send-scheduled] campaign ${c.id} lease lost — another runner took over, stopping`)
      return 'lost'
    }
    lease.token = next
    return 'ok'
  }

  // 이 run 이 소유한 상태에서만 캠페인 행을 확정 (CAS). 성공 여부 반환.
  async function finishOwned(patch: Record<string, unknown>): Promise<boolean> {
    if (!lease.token) return false
    const { data, error } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update(patch)
      .eq('id', c.id)
      .eq('status', 'sending')
      .eq('sending_started_at', lease.token)
      .select('id')
    if (error) {
      console.error(`[send-scheduled] campaign ${c.id} final update failed:`, error.message)
      return false
    }
    if (!data || data.length === 0) {
      console.warn(`[send-scheduled] campaign ${c.id} final update skipped — lease lost`)
      return false
    }
    return true
  }

  // 할당량/레이트리밋 — 남은 수신자는 pending 그대로 두고 캠페인을 예약 상태로 되돌려
  // 정해진 시각에 cron 이 자동 재개하게 한다. (남은 수신자를 failed 로 태우지 않음)
  async function rescheduleCampaign(
    at: Date,
    kind: 'quota' | 'rate',
    detail: string,
    counters: Record<string, unknown> = {},
  ): Promise<boolean> {
    const limitLabel = kind === 'quota' ? 'Gmail 일일 발송 한도' : 'Gmail 발송 속도 제한'
    const ok = await finishOwned({
      ...counters,
      status: 'scheduled',
      scheduled_at: at.toISOString(),
      sending_started_at: null,
      send_attempts: 0,
      last_error: shortReason(`${limitLabel}에 걸려 일시 중지 — ${kstLabel(at)} 에 자동 재개 예정`),
    })
    console.warn(
      `[send-scheduled] campaign ${c.id} rescheduled to ${at.toISOString()} (${kind}: ${detail})${ok ? '' : ' — lease lost, not applied'}`,
    )
    return ok
  }

  // 자발적 pause (예산 소진 / 이번 run 에 로드한 분량 소진) — status='sending' 유지 + 진행 기록,
  // lease 는 now()-85초로 반납해 다음 cron tick 이 곧바로 재개하게 한다 (C-1).
  // CAS 실패(lease 잃음) 면 아무것도 쓰지 않는다.
  async function releaseLease(extra: Record<string, unknown> = {}): Promise<boolean> {
    const prev = lease.token
    if (!prev) return false
    let releaseMs = Date.now() - LEASE_RELEASE_BACKDATE_MS
    // CAS 토큰은 반드시 직전 값과 달라야 한다 (같은 값이면 오래된 소유자의 CAS 가 통과).
    if (releaseMs === Date.parse(prev)) releaseMs -= 1
    const released = new Date(releaseMs).toISOString()
    const { data, error } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ ...extra, sending_started_at: released })
      .eq('id', c.id)
      .eq('status', 'sending')
      .eq('sending_started_at', prev)
      .select('id')
    if (error) {
      console.error(`[send-scheduled] campaign ${c.id} lease release failed:`, error.message)
      return false
    }
    if (!data || data.length === 0) {
      console.warn(`[send-scheduled] campaign ${c.id} lease release skipped — lease lost`)
      return false
    }
    lease.token = released
    return true
  }

  // 계정 전체 오류 (C-6) — 남은 수신자는 pending 그대로, 캠페인은 failed + lease 해제.
  async function failCampaignFatal(
    reason: string,
    counters: Record<string, unknown> = {},
  ): Promise<string> {
    const message = `발송 중단 — ${reason}`
    const ok = await finishOwned({
      ...counters,
      status: 'failed',
      sending_started_at: null,
      last_processed_recipient_id: null,
      send_attempts: 0,
      last_error: shortReason(message),
    })
    console.error(
      `[send-scheduled] campaign ${c.id} fatal account error — ${reason}${ok ? '' : ' (lease lost, not applied)'}`,
    )
    return message
  }

  // 1.5) C-5 — 이전 실행이 남긴 고립 'sending' 행 정리 (락을 쥔 직후, 수신자 로드/완료 집계 전).
  //    정의: status='sending' AND gmail_message_id IS NULL. 발송 직전 claim 후 결과를 기록하지
  //    못한 행 — 워커 크래시/타임아웃, 결과 기록 실패, 브라우저 'record' 정지, 탭 종료 등.
  //    Gmail 이 이미 발송했을 수 있으므로 절대 재발송하지 않는다 → '결과 불확실' failed 로 확정.
  //    lease 를 쥐었으므로 살아있는 서버 실행은 없다. lease 가 늦게 갱신된 브라우저가 아직
  //    그 행을 보내는 중이라도, 여기서는 failed 표시만 하고 다시 보내지 않으므로 중복 발송은
  //    없다 (브라우저가 이후 sent 로 덮어쓰면 그게 정확한 값).
  //    ('scheduled' 로 재등록된 캠페인에도 남아 있을 수 있어 세 진입 경로 모두 적용.)
  const { data: orphanRows, error: orphanErr } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .update({ status: 'failed', error_message: UNCERTAIN_SEND_MESSAGE })
    .eq('campaign_id', c.id)
    .eq('status', 'sending')
    .is('gmail_message_id', null)
    .select('id')
  if (orphanErr) throw transientError(`미확정 발송 행 정리 실패: ${orphanErr.message}`)
  const orphanFailed = (orphanRows ?? []).length
  if (orphanFailed > 0) {
    console.warn(
      `[send-scheduled] campaign ${c.id} marked ${orphanFailed} leftover 'sending' recipients as uncertain-failed (C-5)`,
    )
    // failed_count 즉시 반영 — 이번 run 이 0건으로 끝나도 UI 카운터가 맞도록.
    // (poison-pill 카운터는 리셋하지 않는다 — 발송 중 크래시가 반복되는 캠페인은 결국 멈춰야 함)
    const { count: failedNow, error: fcErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .eq('status', 'failed')
    if (!fcErr && failedNow != null) {
      const st = await touchLease({ failed_count: failedNow })
      if (st !== 'ok') return { sent: 0, failed: orphanFailed, paused: true }
    }
  }

  // 2) 수신자 로드 — status='pending' 만 (C-5: 'sending' 은 위에서 결과 불확실로 확정됨).
  //    개인화 발송(personalized-send) 으로 미리 작성된 per-recipient subject/body
  //    오버라이드도 함께 가져온다 — useSendCampaign.ts 클라이언트 경로와 동작 일치.
  const { data: rawRecipients, error: rErr } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select(
      'id, email, name, variables, subject_override, body_html_override, unsubscribe_token, contact:contacts(is_bounced, is_unsubscribed)',
    )
    .eq('campaign_id', c.id)
    .eq('status', 'pending')
    .is('gmail_message_id', null)
    .order('created_at', { ascending: true })
  if (rErr) throw transientError(`수신자 조회 실패: ${rErr.message}`)

  // 발송 시점 수신거부/차단 목록 — contact 연결 여부와 무관하게 주소 자체로 대조.
  // (contact 가 삭제된 수신자, CC/BCC 주소도 막아야 함) 조회 실패 시 발송하지 않는다.
  const suppressed = await loadSuppressedEmails(supabase, c)

  // 안전망 — 캠페인 생성 시점에 정상이었던 contact 가 그 후 bounce/unsubscribe 됐다면
  // 발송 직전 차단. CampaignWizardPage 가 wizard 시점에 필터하지만, 시간이 지나
  // check-replies 가 bounce 를 감지한 경우 등에 대비.
  type RecipientWithJoin = {
    id: string
    email: string
    name: string | null
    variables: Record<string, unknown> | null
    subject_override: string | null
    body_html_override: string | null
    unsubscribe_token?: string | null
    contact?:
      | { is_bounced: boolean | null; is_unsubscribed: boolean | null }
      | { is_bounced: boolean | null; is_unsubscribed: boolean | null }[]
      | null
  }
  const skipped: Array<{ id: string; reason: string }> = []
  const recipients: Recipient[] = []
  for (const raw of (rawRecipients ?? []) as RecipientWithJoin[]) {
    const ct = Array.isArray(raw.contact) ? raw.contact[0] : raw.contact
    if (ct?.is_bounced) {
      skipped.push({ id: raw.id, reason: '연락처가 반송 상태로 표시되어 발송 차단' })
      continue
    }
    if (ct?.is_unsubscribed) {
      skipped.push({ id: raw.id, reason: '연락처가 수신거부 상태로 발송 차단' })
      continue
    }
    if (raw.email && suppressed.has(normalizeEmail(raw.email))) {
      skipped.push({ id: raw.id, reason: '수신거부/차단 목록에 등록된 주소라 발송 차단' })
      continue
    }
    recipients.push({
      id: raw.id,
      email: raw.email,
      name: raw.name,
      variables: raw.variables,
      subject_override: raw.subject_override,
      body_html_override: raw.body_html_override,
      unsubscribe_token: raw.unsubscribe_token ?? null,
    })
  }
  // 차단된 행은 즉시 failed 처리 — 카운터에 잡히도록.
  // 사유별로 묶어 배치 UPDATE (행당 1회 → 대량 스킵 시 RTT 절감). 실패해도 다음 run 에서
  // 다시 걸러지므로 발송되지는 않는다.
  let skippedMarked = 0
  if (skipped.length > 0) {
    const byReason = new Map<string, string[]>()
    for (const s of skipped) {
      if (!byReason.has(s.reason)) byReason.set(s.reason, [])
      byReason.get(s.reason)!.push(s.id)
    }
    for (const [reason, ids] of byReason) {
      const err = await updateRecipientsByIds(supabase, c.id, ids, {
        status: 'failed',
        error_message: reason,
      })
      if (err) console.error(`[send-scheduled] campaign ${c.id} skip-mark failed:`, err)
      else skippedMarked += ids.length
    }
  }

  if (recipients.length === 0) {
    // 이번 run 에 로드한 행(최대 max_rows=1000) 이 전부 차단돼 비었을 수 있다 — 1000건을 넘는
    // pending 이 남아 있거나 skip-mark 가 실패했으면 'sent' 로 닫지 말고 다음 tick 에 이어서.
    // ('sending' 도 미완료로 센다 — 위 1.5 이후 남아 있다면 다음 run 이 결과 불확실로 정리.)
    const { count: stillPending, error: spErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .in('status', ['pending', 'sending'])
      .is('gmail_message_id', null)
    if (spErr) throw transientError(`미완료 수신자 집계 실패: ${spErr.message}`)
    if ((stillPending ?? 0) > 0) {
      // 차단 행을 failed 로 정리한 것도 진전 — poison-pill 카운터 리셋.
      await releaseLease(skippedMarked > 0 ? { send_attempts: 0 } : {})
      return { sent: 0, failed: skippedMarked, paused: true }
    }
    // 보낼 게 없어도 "완료" — 실제 누적 카운트를 재계산해 기록하고 체크포인트 정리.
    // (전원이 반송/수신거부로 차단된 캠페인이 0 sent / 0 failed 로 보이던 문제 방지)
    const { count: doneSent, error: dsErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .eq('status', 'sent')
    const { count: doneFailed, error: dfErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .eq('status', 'failed')
    // 집계 실패를 0 으로 보면 발송된 캠페인을 'failed' 로 닫고 후속 등록도 빠뜨린다 — 다음 tick 으로.
    if (dsErr || dfErr) {
      throw transientError(`완료 집계 실패: ${(dsErr ?? dfErr)?.message}`)
    }
    // 마지막 수신자가 이전 run 에서 끝났거나 나머지가 전부 차단된 경우 이 분기가 정상 종료 경로 —
    // 일반 종료와 같은 상태 규칙을 쓰고, 후속 시퀀스 등록도 빠뜨리지 않는다.
    const endFailed = (doneSent ?? 0) === 0 && (doneFailed ?? 0) > 0
    const finishedHere = await finishOwned({
      status: endFailed ? 'failed' : 'sent',
      sent_count: doneSent ?? 0,
      failed_count: doneFailed ?? 0,
      sending_started_at: null,
      last_processed_recipient_id: null,
      send_attempts: 0,
      last_error: endFailed
        ? '발송 가능한 수신자가 없습니다 — 전원이 수신거부/반송/발송 실패 상태입니다.'
        : null,
    })
    if (finishedHere && (doneSent ?? 0) > 0) await enrollFollowupSequence(supabase, c)
    return { sent: 0, failed: 0 }
  }

  // AI 개인화 캠페인은 body_html 이 비어 있고 전원이 body_html_override 를 가진다
  // (useSendCampaign.ts 의 allHaveOverride 와 동일 판정).
  const allHaveOverride = recipients.every(
    (r) => typeof r.body_html_override === 'string' && r.body_html_override.trim().length > 0,
  )

  // 3) 본문 확정 — campaign.body_html 을 진실의 원천으로 사용 (useSendCampaign.ts 와 동일)
  let finalBody = c.body_html ?? ''
  if (!finalBody.trim() && !allHaveOverride) {
    console.warn(`[send-scheduled] campaign ${c.id} body_html empty — fallback recompose`)
    const { data: blocks, error: bErr } = await supabase
      .schema('mailcaster')
      .from('campaign_blocks')
      .select('template_id, position')
      .eq('campaign_id', c.id)
      .order('position', { ascending: true })
    if (bErr) throw bErr
    if (blocks && blocks.length > 0) {
      const ids = blocks.map((b: { template_id: string }) => b.template_id)
      const { data: tpls, error: tErr } = await supabase
        .schema('mailcaster')
        .from('templates')
        .select('id, body_html')
        .in('id', ids)
      if (tErr) throw tErr
      const tMap = new Map<string, string>(
        (tpls ?? []).map((t: { id: string; body_html: string | null }) => [
          t.id,
          t.body_html ?? '',
        ])
      )
      const composed = blocks
        .map((b: { template_id: string }) => tMap.get(b.template_id) ?? '')
        .filter(Boolean)
        .join('<br/><br/>')
      if (c.signature_id) {
        const { data: sig } = await supabase
          .schema('mailcaster')
          .from('signatures')
          .select('html')
          .eq('id', c.signature_id)
          .single()
        finalBody = sig?.html ? `${composed}<br/><br/>${sig.html}` : composed
      } else {
        finalBody = composed
      }
    }
  }
  if (!finalBody.trim() && !allHaveOverride) {
    throw new Error('발송할 본문이 비어있습니다')
  }

  // 3.4) 시그니처 fallback — body_html 이 채워져 있어도 시그니처가 빠진 경우 (위저드에서
  //      본문 인라인 편집으로 시그니처를 지운 캠페인) 즉시 발송 (useSendCampaign) 과 동일하게 append.
  //      이게 없으면 같은 캠페인이 발송 경로 (즉시 vs 예약) 에 따라 시그니처 유무가 달라짐.
  //      bodyAlreadyContainsSignature 와 동일한 plain-text fragment 매칭 사용.
  //      (본문이 비어 있는 = 전원 override 캠페인은 공통 본문을 쓰지 않으므로 건너뜀)
  if (c.signature_id && finalBody.trim()) {
    const { data: sig } = await supabase
      .schema('mailcaster')
      .from('signatures')
      .select('html')
      .eq('id', c.signature_id)
      .single()
    const sigHtml = sig?.html ?? ''
    if (sigHtml && !bodyContainsSignature(finalBody, sigHtml)) {
      finalBody = `${finalBody}<br/><br/>${sigHtml}`
    }
  }

  // 3.5) Inline 이미지 추출 — 본문의 <img src="..."> 를 fetch 해서 base64 로 메일에
  //      박는다. 결과: html 의 src 가 cid:xxx 로 치환됨 + inlineImages 배열.
  //      메일 자체가 자기완결적 — Storage URL 이 사라져도 발송된 메일은 영구 표시.
  //      외부 이미지 차단도 우회.
  const { html: bodyWithCids, images: inlineImages } = await extractAndInlineImages(
    finalBody,
  )
  finalBody = bodyWithCids
  const inlineRawBytes = inlineImages.reduce((s, img) => s + img.rawBytes, 0)
  if (inlineImages.length > 0) {
    console.log(`[send-scheduled] campaign ${c.id} inline images: ${inlineImages.length} (${inlineRawBytes} bytes)`)
  }

  // 4) 사용자 프로필 + refresh_token 로 access_token 갱신
  const { data: profile, error: pErr } = await supabase
    .schema('mailcaster')
    .from('profiles')
    .select('email, display_name, default_sender_name, google_refresh_token')
    .eq('id', c.user_id)
    .single()
  if (pErr) throw pErr
  if (!profile?.google_refresh_token) {
    throw new Error('사용자의 Google refresh_token 이 없습니다. 재로그인 필요.')
  }
  // W5) let 으로 보관 — 발송 도중 401 을 받으면 refresh 후 덮어씀.
  //     토큰은 일반적으로 55분 여유가 있지만 운영 중 Google 측 revoke/회전 이벤트가 간헐 발생.
  let accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
  const refreshTokenCached = profile.google_refresh_token as string

  // Gmail 발송 — 401 이면 토큰 갱신 후 1회 재시도 (갱신 후에도 401 이면 fatal).
  // run 안 재시도는 Gmail 이 실제로 돌려준 429/5xx 응답에만 (지수 백오프, run 예산 안에서).
  // 네트워크 오류/타임아웃은 Gmail 이 이미 발송했을 수 있어 절대 재시도하지 않는다 (ambiguous).
  // 남은 예산으로 재시도할 수 없으면 분류된 오류를 그대로 던진다
  // (호출자가 kind 에 따라 pending 복귀/예약 재개/failed/전체 중단 처리).
  async function sendWithRetry(mime: Blob): Promise<{ id: string; threadId: string }> {
    let retries = 0
    let refreshed = false
    // 호출자는 남은 예산이 이 값 이상일 때만 발송을 시작한다 — 시작한 발송을 예산 때문에
    // 중간에 끊지 않도록 clamp 하지 않고 전체 타임아웃을 준다.
    const timeoutMs = gmailTimeoutFor(mime.size)
    for (;;) {
      try {
        return await sendGmailRaw(accessToken, mime, timeoutMs)
      } catch (e) {
        const err = e as TaggedError
        if (err.status === 401) {
          if (refreshed) {
            throw fatalError(
              'Gmail 인증이 거부되었습니다 (토큰 갱신 후에도 401). Google 계정을 다시 연결해 주세요.',
              401,
            )
          }
          refreshed = true
          console.log(`[send-scheduled] 401 → refreshing token for campaign ${c.id}`)
          try {
            accessToken = await refreshGoogleToken(refreshTokenCached)
          } catch (re) {
            // 5xx/네트워크 반복 — 일시 오류로 그대로 (요청 미송신이므로 pending 복귀 안전).
            if ((re as TaggedError)?.transient) throw re
            throw fatalError(
              `Google 계정 인증 갱신에 실패했습니다. Google 계정을 다시 연결해 주세요. (${errMessage(re)})`,
              401,
            )
          }
          // 401 응답은 발송되지 않은 것이 확정 — 같은 메시지를 새 토큰으로 다시 보낸다.
          if (RUN_BUDGET_MS - (Date.now() - runStartedAt) < timeoutMs) {
            const budgetErr = transientError('토큰 갱신 후 남은 run 예산 부족 — 다음 tick 재시도')
            budgetErr.preSend = true
            throw budgetErr
          }
          continue
        }
        const kind = classifyError(err)
        // 재시도는 Gmail 이 돌려준 429/5xx(rate/transient + HTTP status 존재) 에만.
        // 연결 단계 실패(preSend) 는 pending 복귀 후 다음 tick 으로 넘긴다.
        if ((kind !== 'rate' && kind !== 'transient') || err.preSend || err.status == null) throw e
        if (retries >= GMAIL_MAX_RETRIES) throw e
        const backoff = GMAIL_RETRY_BASE_MS * 2 ** retries
        const hinted = err.retryAt ? err.retryAt - Date.now() : 0
        // 서버가 준 Retry-After 가 run 안에서 기다릴 수 없을 만큼 길면 즉시 포기 → 예약 재개
        if (hinted > GMAIL_RETRY_MAX_WAIT_MS) throw e
        const wait = Math.min(GMAIL_RETRY_MAX_WAIT_MS, Math.max(backoff, hinted)) +
          Math.floor(Math.random() * 250)
        const after = RUN_BUDGET_MS - (Date.now() - runStartedAt) - wait
        if (after < timeoutMs) throw e
        retries++
        console.warn(
          `[send-scheduled] campaign ${c.id} gmail ${err.status ?? 'network'} (${kind}) — retry ${retries}/${GMAIL_MAX_RETRIES} in ${wait}ms`,
        )
        await sleep(wait)
      }
    }
  }

  // 5) DB 업데이트 — 토큰 캐시.
  // access_token 은 평문 — 프론트 캐시 (googleToken.ts) 가 이 컬럼을 그대로 Bearer 로 사용.
  await supabase
    .schema('mailcaster')
    .from('profiles')
    .update({
      google_access_token: accessToken,
      token_expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(), // 55분 안전마진
    })
    .eq('id', c.user_id)

  // 6) 첨부 파일 로드 + 파일별 전달 방식 결정 + 다운로드/공유
  //    영구 실패 시 전체 캠페인을 실패 처리 (useSendCampaign.ts 의 preflight 와 동일 정책).
  //    Drive 429/5xx 는 재시도 후에도 실패하면 transient 로 던져 다음 tick 에 재시도.
  const prepared = await prepareAttachments(supabase, accessToken, c.id, c.user_id, inlineRawBytes)

  // 7) 첨부가 있으면 campaign_attachments 에 delivery_mode 기록 (S1: 결정된 모드 저장)
  for (const mode of ['attachment', 'link'] as const) {
    const ids = prepared.filter((a) => a.mode === mode).map((a) => a.id)
    if (ids.length === 0) continue
    await supabase
      .schema('mailcaster')
      .from('campaign_attachments')
      .update({ delivery_mode: mode })
      .eq('campaign_id', c.id)
      .in('attachment_id', ids)
  }

  const fromEmail = (profile.email as string | null) ?? ''
  if (!fromEmail.trim()) {
    // From 이 빈 값이면 Gmail 이 malformed MIME 으로 거부하거나 정체불명의 발송이 됨.
    // 캠페인 자체를 fail 시키는 게 sane default — 운영자가 profile.email 을 채우게 유도.
    throw new Error('사용자 프로필의 이메일 주소가 비어 있습니다.')
  }
  const fromName =
    (profile.default_sender_name as string | null) ?? (profile.display_name as string | null) ?? ''
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  // 캠페인 CC/BCC 도 수신거부/차단 목록과 대조 — 걸린 주소는 조용히 제외.
  const filterSuppressed = (list: string[] | null): string[] => {
    const arr = Array.isArray(list) ? list : []
    return arr.filter((addr) => {
      const blocked = suppressed.has(normalizeEmail(extractAddress(addr)))
      if (blocked) console.log(`[send-scheduled] campaign ${c.id} dropping suppressed cc/bcc address`)
      return !blocked
    })
  }
  const campaignCc: string[] = filterSuppressed(c.cc)
  const campaignBcc: string[] = filterSuppressed(c.bcc)
  const sendMode: 'individual' | 'bulk' = c.send_mode === 'bulk' ? 'bulk' : 'individual'

  // 링크 모드 파일이 있으면 본문에 링크 섹션 append (개별/일괄 공통)
  const linkSection = buildLinkSection(prepared.filter((a) => a.mode === 'link'))
  const bodyWithLinks = linkSection ? `${finalBody}${linkSection}` : finalBody
  // 079 — DB 기본값 true. 명시적으로 끈 캠페인만 수신거부 footer/헤더 생략.
  const includeUnsubscribe = c.include_unsubscribe_link !== false
  // 첨부 + inline 파트는 run 당 1회 인코딩해 MIME 뒷부분(Blob)으로 만들고 모든 수신자가 공유.
  // 수신자별 최종 HTML 이 참조하는 inline 이미지만 포함 (override 본문엔 미참조 이미지 제외).
  const attachParts = prepared.filter((a) => a.mode === 'attachment' && a.wrapped)
  const mimeTails = createMimeTailFactory(
    attachParts.length > 0
      ? attachParts.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          wrapped: a.wrapped!,
        }))
      : undefined,
    inlineImages.length > 0 ? inlineImages : undefined,
  )
  for (const a of attachParts) a.wrapped = undefined // tail Blob 이 보유 — 중복 메모리 해제
  // 수신자별로 달라지지 않는 MIME 부분의 크기(상한) — 예산/타임아웃 추정용
  const staticMimeBytes = mimeTails.maxBytes

  // ------------------------------------------------------------
  // BULK — 1회 호출
  // ------------------------------------------------------------
  if (sendMode === 'bulk') {
    const failAllLoaded = async (errMsg: string, failedCount: number) => {
      // 발송 직전 'sending' 으로 claim 한 행도 포함되므로 status=pending 필터가 아니라
      // id 목록(청크)으로 갱신 — 아니면 'sending' 행이 고립됨.
      const err = await updateRecipientsByIds(
        supabase,
        c.id,
        recipients.map((r) => r.id),
        { status: 'failed', error_message: errMsg },
      )
      if (err) console.error(`[send-scheduled] campaign ${c.id} bulk fail-mark failed:`, err)
      // 카운터는 DB 재집계 — 이번 run 의 차단(skipped) 행과 이전 run 누적까지 반영.
      const { count: fFailed } = await supabase
        .schema('mailcaster').from('recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id).eq('status', 'failed')
      await finishOwned({
        status: 'failed',
        failed_count: fFailed ?? failedCount + orphanFailed + skippedMarked,
        sending_started_at: null,
        last_processed_recipient_id: null,
        send_attempts: 0,
        last_error: shortReason(errMsg),
      })
    }

    // 개인화 오버라이드가 하나라도 있으면 일괄 발송 불가 — 개인별 본문이 손실됨.
    // 빈 문자열은 무시 (실질적으로 override 없음).
    const hasOverride = recipients.some(
      (r) => !!r.subject_override?.trim() || !!r.body_html_override?.trim(),
    )
    if (hasOverride) {
      await failAllLoaded(
        '일괄 발송 모드인데 일부 수신자에 개인화 오버라이드가 있습니다. 개별 발송 모드로 전환하세요.',
        recipients.length,
      )
      return { sent: 0, failed: recipients.length }
    }

    // 개인화 변수 사전 차단
    const vars = [...extractVariables(c.subject ?? ''), ...extractVariables(finalBody)]
    if (vars.length > 0) {
      await failAllLoaded(
        `일괄 발송에는 개인화 변수를 사용할 수 없습니다: ${vars.map((v) => `{{${v}}}`).join(', ')}`,
        recipients.length,
      )
      return { sent: 0, failed: recipients.length }
    }

    // 빈 이메일은 일괄 발송에 포함하면 Gmail 이 전체 호출을 거부할 수 있음.
    // 개별 사전 차단 후 toList 구성.
    const validRecipients = recipients.filter((r) => r.email?.trim())
    const invalidRecipients = recipients.filter((r) => !r.email?.trim())
    if (invalidRecipients.length > 0) {
      const err = await updateRecipientsByIds(
        supabase,
        c.id,
        invalidRecipients.map((r) => r.id),
        { status: 'failed', error_message: '이메일 주소가 비어 있습니다.' },
      )
      if (err) throw transientError(`수신자 상태 갱신 실패: ${err}`)
    }
    if (validRecipients.length === 0) {
      await finishOwned({
        status: 'failed',
        failed_count: invalidRecipients.length + orphanFailed,
        sending_started_at: null,
        last_processed_recipient_id: null,
        send_attempts: 0,
        last_error: '발송 가능한 수신자가 없습니다 (이메일 주소 누락).',
      })
      return { sent: 0, failed: invalidRecipients.length }
    }
    const toList = validRecipients.map((r) => r.email)
    if (toList.length + campaignCc.length + campaignBcc.length > 500) {
      await failAllLoaded(`일괄 발송 수신자 합계가 500명을 초과합니다.`, recipients.length)
      return { sent: 0, failed: recipients.length }
    }

    const bulkHtml = includeUnsubscribe
      ? appendUnsubscribeFooter(bodyWithLinks, buildUnsubscribeFooter(null))
      : bodyWithLinks
    const bulkMime = encodeMime({
      from,
      to: '',
      toList,
      subject: c.subject ?? '',
      html: bulkHtml,
      cc: campaignCc.length > 0 ? campaignCc : undefined,
      bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
    }, mimeTails.forHtml(bulkHtml))
    if (RUN_BUDGET_MS - (Date.now() - runStartedAt) < sendBudgetFor(bulkMime.size)) {
      // 남은 예산으로는 전체 타임아웃을 보장할 수 없음 — 시작한 발송을 중간에 끊지 않도록
      // 시작하지 않는다. lease 반납 → 다음 tick 이 처음부터.
      // 0건 발송 자발적 pause — 전체 예산을 못 받은 run 이면 poison-pill 시도 환불.
      await releaseLease(starvedRefund())
      return { sent: 0, failed: 0, paused: true }
    }
    if ((await touchLease()) !== 'ok') return { sent: 0, failed: 0, paused: true }

    // C-5 크래시 안전 — 발송 직전 대상 전원을 'sending' 으로 claim (CAS: pending 만).
    // 발송 도중 워커가 죽으면 행이 'sending' 으로 남아 다음 run 이 '결과 불확실' 로 확정한다
    // (pending 으로 남으면 다음 run 이 최대 500명에게 다시 보냄). claim 이 전원에 대해 성립하지
    // 않으면 보내지 않는다 — 되돌리고 다음 tick 이 다시 로드.
    const bulkIds = validRecipients.map((r) => r.id)
    const claim = await claimRecipientsForSend(supabase, c.id, bulkIds)
    if (claim.error || claim.claimed.length !== bulkIds.length) {
      console.warn(
        `[send-scheduled] campaign ${c.id} bulk claim incomplete (${claim.claimed.length}/${bulkIds.length})${claim.error ? `: ${claim.error}` : ''} — retry next tick`,
      )
      const revErr = await revertRecipientsToPending(supabase, c.id, claim.claimed)
      if (revErr) console.error(`[send-scheduled] campaign ${c.id} bulk claim revert failed:`, revErr)
      return { sent: 0, failed: 0, paused: true }
    }
    // 미발송이 확정된 오류(할당량/계정 오류/5xx·연결 실패) — claim 을 pending 으로 되돌린다.
    // 되돌리기 실패 시 행은 'sending' 으로 남아 다음 run 이 결과 불확실로 정리 (재발송은 없음).
    const releaseBulkClaim = async () => {
      const revErr = await revertRecipientsToPending(supabase, c.id, bulkIds)
      if (revErr) console.error(`[send-scheduled] campaign ${c.id} bulk claim revert failed:`, revErr)
    }

    let result: { id: string; threadId: string }
    try {
      result = await sendWithRetry(bulkMime)
    } catch (e) {
      const msg = errMessage(e)
      const kind = classifyError(e as TaggedError)
      if (kind === 'quota' || kind === 'rate') {
        await releaseBulkClaim()
        const at = rescheduleTime(kind, (e as TaggedError).retryAt)
        await rescheduleCampaign(at, kind, msg)
        return { sent: 0, failed: 0, paused: true, rescheduled: at.toISOString() }
      }
      if (kind === 'fatal') {
        // 계정 전체 오류 — 발송되지 않음이 확정. 수신자는 pending 으로 복귀, 캠페인만 failed.
        await releaseBulkClaim()
        const error = await failCampaignFatal(msg)
        return { sent: 0, failed: 0, error }
      }
      if (kind === 'ambiguous') {
        // 일괄 1통이 이미 발송됐을 수 있다 — 다음 tick 이 다시 보내면 최대 500명에게 중복.
        // 전원 '결과 불확실' failed 로 확정하고 재발송 경로를 막는다.
        console.error(`[send-scheduled] campaign ${c.id} bulk send outcome unknown:`, msg)
        await failAllLoaded(UNCERTAIN_SEND_MESSAGE, recipients.length)
        return { sent: 0, failed: recipients.length }
      }
      if (kind === 'transient') {
        // Gmail 5xx(재시도 소진) 또는 연결 실패(미송신 확정) — 수신자는 pending 으로 복귀,
        // lease 만료 후 다음 tick 이 재시도.
        console.warn(`[send-scheduled] campaign ${c.id} bulk transient error — retry next tick:`, msg)
        await releaseBulkClaim()
        return { sent: 0, failed: 0, paused: true }
      }
      await failAllLoaded(msg, recipients.length)
      return { sent: 0, failed: recipients.length }
    }

    const sentAt = new Date().toISOString()
    // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — bulk 는 1통이므로 공통 rfc.
    const bulkRfc = c.followup_sequence_id
      ? await fetchMessageRfcId(accessToken, result.id)
      : null
    // 이미 발송됨 — 행 갱신은 재시도 후, 그래도 실패하면 캠페인을 'sent' 로 확정해 재발송 경로
    // 자체를 막는다. (행은 'sending' 으로 남아 혹시 재진입해도 결과 불확실로 정리될 뿐 재발송 없음)
    const sentPatch = {
      status: 'sent',
      sent_at: sentAt,
      gmail_message_id: result.id,
      gmail_thread_id: result.threadId,
      rfc_message_id: bulkRfc,
      error_message: null,
    }
    let updErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      updErr = await updateRecipientsByIds(
        supabase,
        c.id,
        validRecipients.map((r) => r.id),
        sentPatch,
      )
      if (!updErr) break
      await sleep(500 * (attempt + 1))
    }
    if (updErr) {
      console.error(
        `[send-scheduled] campaign ${c.id} bulk sent (gmail ${result.id}) but recipient update failed:`,
        updErr,
      )
    }
    // 카운터는 DB 재집계 — 부분 발송 후 bulk 로 바꾼 캠페인의 이전 누적을 덮어쓰지 않도록.
    // (recipient update 가 실패했으면 재집계가 실제보다 작으므로 이번 run 값으로 대체)
    const [bulkSentCnt, bulkFailedCnt] = await Promise.all([
      supabase.schema('mailcaster').from('recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id).eq('status', 'sent'),
      supabase.schema('mailcaster').from('recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id).eq('status', 'failed'),
    ])
    await finishOwned({
      status: 'sent',
      sent_count: updErr || bulkSentCnt.count == null
        ? validRecipients.length
        : bulkSentCnt.count,
      failed_count: bulkFailedCnt.count ??
        invalidRecipients.length + skipped.length + orphanFailed,
      sending_started_at: null,
      last_processed_recipient_id: null,
      send_attempts: 0,
      last_error: null,
    })
    // 첨부 이력 기록 — 발송된 수신자만 (invalidRecipients 제외)
    await recordRecipientAttachments(supabase, c, validRecipients, prepared)
    // 후속 시퀀스 등록 (발송 완료 시)
    await enrollFollowupSequence(supabase, c)
    return { sent: validRecipients.length, failed: invalidRecipients.length }
  }

  // ------------------------------------------------------------
  // INDIVIDUAL — 수신자별 루프
  //
  // Phase 6 (A) — 시간 예산을 넘으면 체크포인트 저장 후 중단.
  //   - recipients 를 로드할 때 이미 status='pending' 만 가져오므로 재진입 안전.
  //   - 각 반복마다 "다음 발송을 시작할 시간" 이 RUN_BUDGET_MS 를 넘는지 확인.
  //     남은 시간이 메시지 크기에 맞는 발송 예산보다 적으면 pause.
  //   - pause 시 status 는 'sending' 을 유지 (campaign row 는 다음 tick 에 cron 이 재개).
  //   - 매 발송 직전 lease CAS — 다른 실행이 가져갔거나 취소됐으면 즉시 중단.
  // ------------------------------------------------------------
  let sent = 0
  let failed = 0
  let paused = false
  // 예산 소진으로 인한 자발적 pause — 마무리에서 lease 를 반납(C-1). DB/일시 오류 pause 는
  // heartbeat 를 그대로 둬 자연 만료(= 한 tick 쉬는 백오프) 시킨다.
  let voluntaryPause = false
  let leaseLost = false
  let fatalMessage: string | null = null
  let rescheduleAt: Date | null = null
  let rescheduleKind: 'quota' | 'rate' = 'rate'
  let rescheduleReason = ''
  const delaySeconds = Math.min(MAX_SERVER_DELAY_SECONDS, Math.max(0, c.send_delay_seconds ?? 3))
  const delayMs = delaySeconds * 1000

  // W6) baseline — "재개 시점의 누적 sent/failed" 를 1회만 조회.
  //     이후 루프 안에서는 로컬 카운터(sent/failed) 를 더해 UPDATE — 매 루프 count 쿼리 2회 제거.
  //     신규 발송의 경우 baseline 은 0/0. 재개의 경우엔 이미 sent 된 것들의 누적값.
  const { count: baselineSentRaw } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'sent')
  const { count: baselineFailedRaw } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'failed')
  const baselineSent = baselineSentRaw ?? 0
  const baselineFailed = baselineFailedRaw ?? 0
  let lastProcessedId: string | null = null

  // 진행 카운터 + 체크포인트. 이 run 에서 1명이라도 처리했으면 poison-pill 카운터를 리셋.
  const progressFields = (): Record<string, unknown> =>
    lastProcessedId
      ? {
          sent_count: baselineSent + sent,
          failed_count: baselineFailed + failed,
          last_processed_recipient_id: lastProcessedId,
          send_attempts: 0,
        }
      : {}

  const revertToPending = async (id: string) => {
    const { error } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .update({ status: 'pending' })
      .eq('id', id)
      .eq('status', 'sending')
    if (error) console.error(`[send-scheduled] recipient ${id} revert-to-pending failed:`, error.message)
  }

  // C-4 — 개별 발송이라도 캠페인 CC/BCC 가 있으면 같은 1통을 CC/BCC 수신자도 받는다.
  // List-Unsubscribe(one-click) 를 달면 CC/BCC 수신자가 메일 클라이언트의 '구독 취소' 로
  // To 수신자를 수신거부시키게 되므로 헤더는 생략한다. 본문 footer 링크는 유지 —
  // 수신거부 페이지가 마스킹된 이메일을 보여줘 CC 수신자도 본인 주소가 아님을 알 수 있다.
  const allowListUnsubscribeHeader = campaignCc.length === 0 && campaignBcc.length === 0

  for (let i = 0; i < recipients.length; i++) {
    // 이 반복을 시작하기 전에 남은 예산 확인 — 전체 Gmail 타임아웃을 보장할 수 있어야 시작.
    const remaining = RUN_BUDGET_MS - (Date.now() - runStartedAt)
    if (remaining < sendBudgetFor(staticMimeBytes)) {
      paused = true
      voluntaryPause = true
      console.log(
        `[send-scheduled] campaign ${c.id} pausing at ${i}/${recipients.length} — remaining=${remaining}ms`
      )
      break
    }

    const r = recipients[i] as Recipient

    // 빈 이메일 사전 차단 — Gmail API 가 묵묵히 실패하거나 부분 성공으로 빠져 사용자가 인지 못 함.
    if (!r.email || !r.email.trim()) {
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: '이메일 주소가 비어 있습니다.' })
        .eq('id', r.id)
      failed++
      lastProcessedId = r.id
      continue
    }

    let preMarked = false
    try {
      const vars = buildVariables(r)
      // 개인화 오버라이드 우선 — useSendCampaign.ts 와 동일 정책. (LLM 이 사람마다 직접
      // 작성한 문장이라 템플릿 변수 치환은 적용하지 않는다.)
      // 빈 문자열은 null 처럼 취급 — '' 가 들어 있으면 빈 제목/본문 발송 위험.
      const subjOverride = r.subject_override?.trim() ? r.subject_override : null
      const bodyOverride = r.body_html_override?.trim() ? r.body_html_override : null
      const subject = subjOverride ?? renderTemplate(c.subject ?? '', vars)
      const renderedHtml = bodyOverride
        ? (linkSection ? `${bodyOverride}${linkSection}` : bodyOverride)
        : renderTemplateHtml(bodyWithLinks, vars)
      // 링크 클릭 트래킹 — 본문 링크를 track-click 리다이렉트로 래핑 (오픈 트래킹 설정 공유).
      // 개별 발송만 가능 (bulk 는 본문이 전 수신자 공유라 수신자별 rid 를 넣을 수 없음).
      const linkWrapped = c.enable_open_tracking
        ? await wrapLinksForClickTracking(
            renderedHtml,
            { rid: r.id, cid: c.id },
            SUPABASE_URL,
            CLICK_SIGNING_SECRET,
          )
        : renderedHtml
      // 079 — 수신거부 footer (클릭 래핑 이후 — 리다이렉트 미경유). 토큰 없는 행은 회신 안내로 대체.
      // C-2 — footer 는 사람용 SPA 페이지(GitHub Pages), 헤더는 RFC 8058 one-click Edge Function.
      const unsubPageUrl = includeUnsubscribe ? buildUnsubscribePageUrl(r.unsubscribe_token) : null
      const oneClickUrl = includeUnsubscribe && allowListUnsubscribeHeader
        ? buildOneClickUnsubscribeUrl(r.unsubscribe_token)
        : null
      const withFooter = includeUnsubscribe
        ? appendUnsubscribeFooter(linkWrapped, buildUnsubscribeFooter(unsubPageUrl))
        : linkWrapped
      // Phase 6 (C) — 오픈 추적 픽셀 주입 (캠페인 설정 on 일 때만)
      const html = c.enable_open_tracking
        ? injectTrackingPixel(withFooter, buildTrackingPixel(r.id, c.id))
        : withFooter
      const mime = encodeMime({
        from,
        to: r.email,
        toName: r.name,
        subject,
        html,
        cc: campaignCc.length > 0 ? campaignCc : undefined,
        bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
        listUnsubscribeUrl: oneClickUrl,
      }, mimeTails.forHtml(html))
      if (RUN_BUDGET_MS - (Date.now() - runStartedAt) < sendBudgetFor(mime.size)) {
        paused = true
        voluntaryPause = true
        console.log(`[send-scheduled] campaign ${c.id} pausing at ${i}/${recipients.length} — budget < send timeout`)
        break
      }

      // 발송 직전 소유 확인 + lease 연장 (+ 진행 카운터 / poison-pill 리셋)
      const leaseState = await touchLease(progressFields())
      if (leaseState !== 'ok') {
        if (leaseState === 'lost') leaseLost = true
        paused = true
        break
      }

      // pre-mark = 수신자 claim (CAS: pending 만 — C-5). 스냅샷 로드 이후 삭제됐거나 이미
      // 처리(sent/failed)됐거나 다른 실행이 'sending' 으로 잡은 행이면 0건 → 보내지 않고 건너뛴다.
      // 발송 도중 크래시하면 이 행은 'sending' 으로 남고, 다음 run 이 결과 불확실로 확정한다.
      const { data: claimed, error: markErr } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'sending' })
        .eq('id', r.id)
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
        .is('gmail_message_id', null)
        .select('id')
      if (markErr) {
        console.error(`[send-scheduled] recipient ${r.id} pre-mark failed — pausing:`, markErr.message)
        paused = true
        break
      }
      if (!claimed || claimed.length === 0) {
        console.log(`[send-scheduled] recipient ${r.id} no longer pending (removed/processed) — skip`)
        continue
      }
      preMarked = true

      const result = await sendWithRetry(mime)
      // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — followup In-Reply-To 용.
      const rfcMessageId = c.followup_sequence_id
        ? await fetchMessageRfcId(accessToken, result.id)
        : null
      sent++
      lastProcessedId = r.id
      // 이미 발송됨 — 행 갱신은 재시도. 그래도 실패하면 DB 장애로 보고 더 보내지 않고 멈춘다.
      // (행은 'sending' 으로 남아 다음 run 이 결과 불확실 failed 로 정리 — 재발송은 없음)
      const markedSent = await markRecipientSent(supabase, r.id, {
        status: 'sent',
        sent_at: new Date().toISOString(),
        gmail_message_id: result.id,
        gmail_thread_id: result.threadId,
        rfc_message_id: rfcMessageId,
        error_message: null,
      })
      if (!markedSent) {
        console.error(
          `[send-scheduled] recipient ${r.id} sent (gmail ${result.id}) but status update failed — pausing`,
        )
        paused = true
        break
      }
      // 개별 수신자 첨부 이력 기록
      await recordRecipientAttachments(supabase, c, [r], prepared)
    } catch (e) {
      const msg = errMessage(e)
      const kind = classifyError(e as TaggedError)
      if (kind === 'quota' || kind === 'rate') {
        // 할당량/레이트리밋 — 이 수신자는 pending 으로 되돌리고 캠페인을 예약 재개로 전환.
        if (preMarked) await revertToPending(r.id)
        rescheduleAt = rescheduleTime(kind, (e as TaggedError).retryAt)
        rescheduleKind = kind
        rescheduleReason = msg
        break
      }
      if (kind === 'fatal') {
        // 계정 전체 오류 (C-6) — 이 수신자는 미발송 확정이라 pending 복귀, 남은 수신자도 pending.
        // 캠페인은 마무리에서 failed 로 내린다.
        if (preMarked) await revertToPending(r.id)
        fatalMessage = msg
        break
      }
      if (kind === 'ambiguous') {
        // C-5 — 요청 송신 후 결과를 모름. Gmail 이 이미 발송했을 수 있으므로 재시도/pending 복귀
        // 금지 → '결과 불확실' failed 로 확정하고 다음 수신자로 진행.
        console.error(`[send-scheduled] recipient ${r.id} send outcome unknown:`, msg)
        const recorded = await markRecipientSent(supabase, r.id, {
          status: 'failed',
          error_message: UNCERTAIN_SEND_MESSAGE,
        })
        if (!recorded) {
          // 기록조차 못 함 — DB 장애로 보고 더 보내지 않는다.
          console.error(`[send-scheduled] recipient ${r.id} uncertain-mark failed — pausing`)
          paused = true
          break
        }
        failed++
        lastProcessedId = r.id
      } else if (kind === 'transient') {
        // Gmail 5xx 재시도 소진 또는 연결 실패(미송신 확정) — failed 로 태우지 않고
        // pending 복귀 후 pause (다음 tick 재시도).
        console.warn(`[send-scheduled] recipient ${r.id} transient error — will retry next tick:`, msg)
        if (preMarked) await revertToPending(r.id)
        paused = true
        break
      } else {
        console.error(`[send-scheduled] recipient ${r.email} failed:`, msg)
        await supabase
          .schema('mailcaster')
          .from('recipients')
          .update({ status: 'failed', error_message: msg })
          .eq('id', r.id)
        failed++
        lastProcessedId = r.id
      }
    }

    if (i < recipients.length - 1 && delayMs > 0) {
      // delay 도중 예산 초과되면 쉬지 않고 깔끔히 탈출
      const before = Date.now()
      if (before - runStartedAt + delayMs > RUN_BUDGET_MS - sendBudgetFor(staticMimeBytes)) {
        paused = true
        voluntaryPause = true
        console.log(
          `[send-scheduled] campaign ${c.id} pausing during delay window after ${i + 1}/${recipients.length}`
        )
        break
      }
      await sleep(delayMs)
    }
  }

  // ------------------------------------------------------------
  // 마무리 — lease 를 잃었으면 아무것도 쓰지 않는다 (새 소유자가 이어서 처리).
  //          할당량이면 예약 재개, paused 면 status='sending' 유지 (다음 cron 이 재개),
  //          완료면 sent/failed 결정.
  // ------------------------------------------------------------
  if (leaseLost) return { sent, failed, paused: true }

  if (fatalMessage) {
    // C-6 — 계정 전체 오류. 진행 카운터는 기록하고 캠페인 failed + lease 해제.
    const error = await failCampaignFatal(fatalMessage, progressFields())
    return { sent, failed, error }
  }

  if (rescheduleAt) {
    await rescheduleCampaign(rescheduleAt, rescheduleKind, rescheduleReason, progressFields())
    return { sent, failed, paused: true, rescheduled: rescheduleAt.toISOString() }
  }

  if (paused) {
    if (voluntaryPause) {
      // 예산 소진 — 진행 기록 + lease 반납 (C-1). 다음 tick 이 곧바로 재개.
      // 0건 처리로 끝났고 이 run 이 전체 예산을 못 받았으면 poison-pill 시도 환불.
      await releaseLease(lastProcessedId ? progressFields() : starvedRefund())
    } else if (lastProcessedId) {
      // DB/일시 오류 pause — 진행만 기록하고 heartbeat 는 자연 만료(한 tick 쉬는 백오프).
      await touchLease(progressFields())
    }
    return { sent, failed, paused: true }
  }

  // 루프 종료 시 체크포인트 1회 플러시 — 마지막 구간 카운터 + poison-pill 리셋.
  if (lastProcessedId) {
    const flushed = await touchLease(progressFields())
    if (flushed !== 'ok') return { sent, failed, paused: true }
  }

  // 남은 미완료 (pending 또는 'sending') 이 0 이어야 "완료".
  // 'sending' (gmail_message_id IS NULL) 이 남아 있으면 'sent' 로 닫지 않는다 — 다음 run 이
  // 락 직후 결과 불확실 failed 로 정리(C-5)한 뒤 완료 처리한다 (재발송은 하지 않음).
  const { count: remainingIncomplete, error: riErr } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .in('status', ['pending', 'sending'])
    .is('gmail_message_id', null)

  if (riErr) {
    // 완료 여부를 확인 못 함 — 'sent' 로 닫지 않고 lease 자연 만료 후 다음 tick 이 재확인.
    console.error(`[send-scheduled] campaign ${c.id} remaining count failed:`, riErr.message)
    return { sent, failed, paused: true }
  }
  if ((remainingIncomplete ?? 0) > 0) {
    // 이번 run 에 로드한 분량(max_rows) 을 다 처리했지만 미처리 행이 남음 — 자발적 pause.
    await releaseLease()
    return { sent, failed, paused: true }
  }

  // 최종 집계 재계산
  const { count: totalSentCount } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'sent')
  const { count: totalFailedCount } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'failed')

  const sentTotal = totalSentCount ?? 0
  const failedTotal = totalFailedCount ?? 0
  const finalStatus = sentTotal === 0 && failedTotal > 0 ? 'failed' : 'sent'
  // 완료 시 체크포인트 정리 — 남겨두면 수동 재발송이 재개 경로에 오진입 (W7 과 동일 이유).
  const finished = await finishOwned({
    status: finalStatus,
    sent_count: sentTotal,
    failed_count: failedTotal,
    sending_started_at: null,
    last_processed_recipient_id: null,
    send_attempts: 0,
    last_error: finalStatus === 'sent'
      ? null
      : '모든 수신자 발송에 실패했습니다 — 수신자별 오류 메시지를 확인해 주세요.',
  })

  // 후속 시퀀스 등록 (개별 발송 완료 시 — paused 가 아니라 실제 완료된 경우만 여기 도달)
  if (finished) await enrollFollowupSequence(supabase, c)

  return { sent, failed }
}

// ------------------------------------------------------------
// lease / 수신자 갱신 / 수신거부 도우미
// ------------------------------------------------------------

// 직전 lease 와 반드시 다른 새 값 — 같은 ms 에 두 번 쓰면 CAS 토큰이 안 바뀌는 문제 방지.
function nextLeaseValue(prev: string | null): string {
  let ms = Date.now()
  const prevMs = prev ? Date.parse(prev) : NaN
  if (!Number.isNaN(prevMs) && ms <= prevMs) ms = prevMs + 1
  return new Date(ms).toISOString()
}

// .in('id', 대량) 은 URL 길이 한도(414)에 걸릴 수 있어 청크로 나눠 갱신. 오류 메시지 반환.
async function updateRecipientsByIds(
  supabase: Db,
  campaignId: string,
  ids: string[],
  patch: Record<string, unknown>,
): Promise<string | null> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { error } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .update(patch)
      .eq('campaign_id', campaignId)
      .in('id', ids.slice(i, i + ID_CHUNK))
    if (error) return error.message ?? String(error)
  }
  return null
}

// 발송 직전 claim — pending 인 행만 'sending' 으로 (청크). 실제로 claim 된 id 목록 반환.
async function claimRecipientsForSend(
  supabase: Db,
  campaignId: string,
  ids: string[],
): Promise<{ claimed: string[]; error: string | null }> {
  const claimed: string[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .update({ status: 'sending' })
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .is('gmail_message_id', null)
      .in('id', ids.slice(i, i + ID_CHUNK))
      .select('id')
    if (error) return { claimed, error: error.message ?? String(error) }
    for (const row of (data ?? []) as Array<{ id: string }>) claimed.push(row.id)
  }
  return { claimed, error: null }
}

// 미발송이 확정된 claim 되돌리기 — 'sending' 인 행만 pending 으로 (청크). 오류 메시지 반환.
async function revertRecipientsToPending(
  supabase: Db,
  campaignId: string,
  ids: string[],
): Promise<string | null> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { error } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .update({ status: 'pending' })
      .eq('campaign_id', campaignId)
      .eq('status', 'sending')
      .is('gmail_message_id', null)
      .in('id', ids.slice(i, i + ID_CHUNK))
    if (error) return error.message ?? String(error)
  }
  return null
}

async function markRecipientSent(
  supabase: Db,
  recipientId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .update(patch)
      .eq('id', recipientId)
    if (!error) return true
    console.warn(`[send-scheduled] recipient ${recipientId} sent-update retry ${attempt + 1}:`, error.message)
    await sleep(300 * (attempt + 1))
  }
  return false
}

// campaigns.last_error 용 짧은 사유 (UI 표시)
function shortReason(s: string): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > LAST_ERROR_MAX_CHARS ? `${t.slice(0, LAST_ERROR_MAX_CHARS - 1)}…` : t
}

// 재개 예정 시각 표시 (KST) — 예: "10. 5. 오후 3:20"
function kstLabel(d: Date): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d)
  } catch {
    return d.toISOString()
  }
}

function normalizeEmail(s: string): string {
  return (s ?? '').trim().toLowerCase()
}

// "Name <a@b.com>" → "a@b.com"
function extractAddress(addr: string): string {
  const m = (addr ?? '').match(/<([^>]+)>/)
  return m ? m[1] : addr ?? ''
}

// 조직의 unsubscribes + blacklist 이메일 (소문자) 집합. PostgREST max-rows 에 상관없이
// 빈 페이지가 나올 때까지 페이지네이션. 조회 실패 시 transient — 확인 못 한 채 발송하지 않는다.
async function loadSuppressedEmails(supabase: Db, c: Campaign): Promise<Set<string>> {
  const out = new Set<string>()
  const PAGE = 1000
  for (const table of ['unsubscribes', 'blacklist'] as const) {
    let offset = 0
    for (;;) {
      let q = supabase.schema('mailcaster').from(table).select('id, email')
      q = c.org_id ? q.eq('org_id', c.org_id) : q.eq('user_id', c.user_id)
      const { data, error } = await q.order('id', { ascending: true }).range(offset, offset + PAGE - 1)
      if (error) {
        // blacklist 는 레거시 테이블 — 없어진 환경이면 무시
        if (table === 'blacklist' && isMissingRelation(error)) break
        throw transientError(`수신거부 목록 조회 실패 (${table}): ${error.message}`)
      }
      const rows = (data ?? []) as Array<{ email: string | null }>
      for (const row of rows) {
        const e = normalizeEmail(row.email ?? '')
        if (e) out.add(e)
      }
      if (rows.length === 0) break
      offset += rows.length
    }
  }
  return out
}

function isMissingRelation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(error.message ?? '')
  )
}

function classifyError(err: TaggedError | null | undefined): GmailErrorKind {
  if (!err) return 'permanent'
  if (err.kind) return err.kind
  if (err.transient) return 'transient'
  return 'permanent'
}

// 할당량/레이트리밋 재개 시각 — Gmail 이 Retry-After 를 주면 그 시각(범위 clamp), 아니면 기본값.
function rescheduleTime(kind: 'quota' | 'rate', retryAt: number | null | undefined): Date {
  const now = Date.now()
  const fallback = kind === 'quota' ? QUOTA_RESCHEDULE_MS : RATE_RESCHEDULE_MS
  let at = retryAt && retryAt > now ? retryAt + 60_000 : now + fallback
  at = Math.max(at, now + RATE_RESCHEDULE_MS)
  at = Math.min(at, now + MAX_RESCHEDULE_MS)
  return new Date(at)
}

// 메시지 크기 → Gmail 호출 타임아웃 (기본 10초 + MB 당 1초, 최대 40초)
function gmailTimeoutFor(bytes: number): number {
  return Math.min(40_000, 10_000 + Math.ceil(bytes / (1024 * 1024)) * 1_000)
}

// 메시지 크기 → 발송을 "시작" 하는 데 필요한 최소 남은 예산.
// = Gmail 호출 전체 타임아웃 + 직전 lease 갱신/pre-mark DB 왕복 여유(1초).
// 시작한 발송은 예산 때문에 중간에 끊지 않는다 — 끊으면 결과 불확실(중복 위험)로 남는다.
const PRE_SEND_DB_MARGIN_MS = 1_000
function sendBudgetFor(bytes: number): number {
  return gmailTimeoutFor(bytes) + PRE_SEND_DB_MARGIN_MS
}

// ------------------------------------------------------------
// 첨부 준비 — 파일별 delivery_mode 결정 후 base64/링크 확보
//   - Google 문서/시트/슬라이드(vnd.google-apps.*) 와 크기 불명 파일은 alt=media 다운로드가
//     불가(403)하므로 항상 link.
//   - 나머지는 (원본 합계 + inline 이미지) 가 ATTACHMENT_SAFE_THRESHOLD 이하면 첨부, 초과면 전부 link.
//   - 크기/타입은 DB 캐시가 아니라 Drive 실시간 메타 기준 (파일이 그 사이 바뀌었을 수 있음).
// ------------------------------------------------------------
async function prepareAttachments(
  supabase: Db,
  accessToken: string,
  campaignId: string,
  userId: string,
  inlineBytes: number,
): Promise<PreparedAttachment[]> {
  // 1) campaign_attachments + drive_attachments 조인
  const { data: rows, error } = await supabase
    .schema('mailcaster')
    .from('campaign_attachments')
    .select('attachment_id, sort_order, drive_attachments(*)')
    .eq('campaign_id', campaignId)
    .order('sort_order', { ascending: true })
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const driveRows: DriveAttachmentRow[] = (rows as Array<{ drive_attachments: unknown }>)
    .map((r) => r.drive_attachments as DriveAttachmentRow)
    .filter(Boolean)

  if (driveRows.length === 0) return []

  // 2) 파일 메타 재확인 — Drive 에서 삭제된 파일 skip
  const alive: Array<{ row: DriveAttachmentRow; size: number | null; mimeType: string }> = []
  for (const a of driveRows) {
    try {
      const meta = await driveGetMeta(accessToken, a.drive_file_id)
      alive.push({
        row: a,
        size: meta.size ?? a.file_size,
        mimeType: meta.mimeType ?? a.mime_type ?? 'application/octet-stream',
      })
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 404) {
        console.warn(`[send-scheduled] attachment ${a.file_name} deleted from Drive — skip`)
        await supabase
          .schema('mailcaster')
          .from('drive_attachments')
          .update({ deleted_from_drive_at: new Date().toISOString() })
          .eq('id', a.id)
          .eq('user_id', userId)
      } else {
        throw e
      }
    }
  }
  if (alive.length === 0) {
    throw new Error('첨부 파일이 모두 Drive 에서 삭제되었습니다. 발송을 중단합니다.')
  }

  // 3) 모드 결정
  const forcedLink = (x: { size: number | null; mimeType: string }) =>
    x.size == null || x.mimeType.startsWith('application/vnd.google-apps.')
  const attachableBytes = alive
    .filter((x) => !forcedLink(x))
    .reduce((s, x) => s + (x.size ?? 0), 0)
  const attachOk = attachableBytes + inlineBytes <= ATTACHMENT_SAFE_THRESHOLD
  console.log('[send-scheduled] attachments', {
    count: alive.length,
    attachableBytes,
    inlineBytes,
    forcedLink: alive.filter(forcedLink).length,
    mode: attachOk ? 'attachment' : 'link',
  })

  const prepared: PreparedAttachment[] = []
  for (const x of alive) {
    const a = x.row
    if (attachOk && !forcedLink(x)) {
      // 다운로드 후 base64(76자 wrap) 인코딩 — 수신자 수와 무관하게 run 당 1회만
      const bytes = await driveDownload(accessToken, a.drive_file_id)
      prepared.push({
        id: a.id,
        filename: a.file_name,
        mimeType: x.mimeType,
        size: bytes.byteLength,
        mode: 'attachment',
        wrapped: base64Encode(bytes, { wrap: true }),
      })
      continue
    }
    // link 모드 — 이미 공개 공유된 건 캐시된 link 재사용
    let link: string
    if (a.is_public_shared && a.web_view_link) {
      link = a.web_view_link
    } else {
      link = await driveShareAsPublicLink(accessToken, a.drive_file_id)
      await supabase
        .schema('mailcaster')
        .from('drive_attachments')
        .update({ is_public_shared: true, web_view_link: link })
        .eq('id', a.id)
        .eq('user_id', userId)
    }
    prepared.push({
      id: a.id,
      filename: a.file_name,
      mimeType: x.mimeType,
      size: x.size,
      mode: 'link',
      link,
    })
  }
  return prepared
}

// ------------------------------------------------------------
// 수신자 × 첨부 매핑 이력 기록 (recipient_attachments)
// ------------------------------------------------------------
async function recordRecipientAttachments(
  supabase: Db,
  campaign: { id: string; user_id: string; name: string },
  recipients: Array<{ id: string; email: string; name: string | null }>,
  prepared: PreparedAttachment[],
): Promise<void> {
  if (prepared.length === 0 || recipients.length === 0) return
  // recipient_attachments 는 recipient_email NOT NULL + link_url 컬럼 없음 (migration 004).
  // 즉시 발송 경로(useSendCampaign)와 동일하게 denormalized 컬럼을 채운다.
  const rows: Array<Record<string, unknown>> = []
  for (const rcpt of recipients) {
    for (const a of prepared) {
      rows.push({
        user_id: campaign.user_id,
        recipient_id: rcpt.id,
        campaign_id: campaign.id,
        recipient_email: rcpt.email,
        recipient_name: rcpt.name,
        campaign_name: campaign.name,
        attachment_id: a.id,
        delivery_mode: a.mode,
      })
    }
  }
  // bulk 는 수신자 × 첨부 수만큼 행이 생겨 한 번에 넣기엔 클 수 있음 — 청크 insert
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .schema('mailcaster')
      .from('recipient_attachments')
      .insert(rows.slice(i, i + 500))
    if (error) {
      console.warn('[send-scheduled] recipient_attachments insert failed:', error.message)
    }
  }
}

// ------------------------------------------------------------
// 069 — 발송 완료 후 후속 시퀀스 등록 (service_role). best-effort.
//   RPC enroll_campaign_recipients 가 'sent' 수신자를 캠페인 스레드 followup 으로 등록.
//   recipients.rfc_message_id 는 발송 시점에 채워둠(즉시·예약 동일) → followup In-Reply-To 연결.
// ------------------------------------------------------------
async function enrollFollowupSequence(
  supabase: Db,
  campaign: Campaign,
): Promise<void> {
  if (!campaign.followup_sequence_id) return
  const { data, error } = await supabase
    .schema('mailcaster')
    .rpc('enroll_campaign_recipients', { p_campaign_id: campaign.id })
  if (error) {
    console.warn(`[send-scheduled] follow-up enroll failed for ${campaign.id}:`, error.message)
  } else if (data) {
    console.log(`[send-scheduled] campaign ${campaign.id} enrolled ${data} into follow-up sequence`)
  }
}

// 069 — 발송한 메일의 RFC822 Message-ID 조회 (후속 시퀀스 In-Reply-To/References 용).
//   best-effort — 실패 시 null (gmail_thread_id 만으로도 Gmail 스레드는 묶임).
//   후속 시퀀스가 붙은 캠페인에서만 호출해 평상시 발송엔 추가 API 비용이 없게 한다.
//   타임아웃 필수 — 발송 성공 후 'sent' 기록 전에 호출되므로 hang 하면 lease 가 만료돼
//   다음 run 이 같은 수신자에게 재발송할 수 있다.
async function fetchMessageRfcId(accessToken: string, gmailMessageId: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal },
    )
    if (!res.ok) return null
    const data = await res.json()
    const headers = data.payload?.headers ?? []
    const found = headers.find((h: { name: string }) => h.name.toLowerCase() === 'message-id')
    return found?.value ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// Helpers
// ============================================================

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function buildVariables(r: Recipient): Record<string, string> {
  const base: Record<string, string> = { email: r.email, name: r.name ?? '' }
  if (r.variables && typeof r.variables === 'object') {
    for (const [k, v] of Object.entries(r.variables)) {
      base[k] = v == null ? '' : String(v)
    }
  }
  return base
}

function renderTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k]
    return v == null ? '' : String(v)
  })
}

// HTML 본문용 — 변수 값을 HTML 엔티티로 이스케이프해 삽입 (클라이언트 renderTemplateHtml 과 동일 정책)
function renderTemplateHtml(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k]
    if (v == null) return ''
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  })
}

function extractVariables(input: string): string[] {
  const set = new Set<string>()
  const re = /\{\{\s*([\w.]+)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) set.add(m[1])
  return Array.from(set)
}

// W5) transient 5xx / 네트워크 오류에 대해 지수 백오프 재시도.
//     401/400 은 refresh_token 자체 문제이므로 즉시 중단 (재시도해도 같은 결과).
async function refreshGoogleToken(storedToken: string): Promise<string> {
  // DB 에 암호화되어 저장된 refresh_token 복호화 (평문 저장 기존 토큰도 그대로 통과)
  const refreshToken = await decryptToken(storedToken)
  const MAX_ATTEMPTS = 3
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      })
      if (res.ok) {
        const json = await res.json()
        if (!json.access_token) throw new Error('access_token 미반환')
        return json.access_token as string
      }
      const body = await res.text()
      // 4xx — refresh_token invalid / revoked. 재시도 무의미.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Google OAuth 실패 (${res.status}): ${body}`)
      }
      // 5xx — transient
      lastErr = new Error(`Google OAuth ${res.status}: ${body}`)
    } catch (e) {
      lastErr = e
      // 4xx 는 위에서 throw 했으므로 여기 도착 = network/5xx. 재시도 허용.
      if (e instanceof Error && e.message.startsWith('Google OAuth 실패')) throw e
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 300 * attempt)) // 300, 600ms
    }
  }
  // 여기 도달 = 5xx/네트워크 오류만 반복 — 캠페인을 failed 로 내리지 말고 다음 tick 재시도.
  throw transientError(
    `Google OAuth 일시 오류: ${lastErr instanceof Error ? lastErr.message : 'refreshGoogleToken failed'}`,
  )
}

// ============================================================
// Drive API 헬퍼 — src/lib/drive.ts 의 Deno 포트
// (필요한 3개만 인라인 구현: getFileMeta / downloadFile / shareAsPublicLink)
// ============================================================
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])

// Drive 호출 + 429/5xx/레이트리밋 403/네트워크 오류 3회 재시도 (500ms → 1s → 2s).
// 매 run 시작마다 메타/다운로드를 다시 하므로 일시 오류 하나로 진행 중 캠페인이 죽지 않게.
async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const MAX_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (attempt >= MAX_RETRIES) {
        throw transientError(`Drive API 네트워크 오류: ${errMessage(e)}`)
      }
    }
    if (res) {
      if (res.ok || attempt >= MAX_RETRIES || !(await isRetryableDrive(res))) return res
      await res.body?.cancel().catch(() => {})
    }
    await sleep(500 * 2 ** attempt)
  }
}

async function isRetryableDrive(res: Response): Promise<boolean> {
  if (res.status === 429 || res.status >= 500) return true
  if (res.status !== 403) return false
  const reason = await res.clone().json().then(
    (j) => j?.error?.errors?.[0]?.reason as string | undefined,
    () => undefined,
  )
  return !!reason && DRIVE_RATE_REASONS.has(reason)
}

async function driveToError(res: Response): Promise<TaggedError> {
  const bodyText = await res.text().catch(() => '')
  let message = `Drive API ${res.status}`
  let reason: string | undefined
  try {
    const j = JSON.parse(bodyText)
    message = j?.error?.message || message
    reason = j?.error?.errors?.[0]?.reason
  } catch {
    if (bodyText) message = bodyText
  }
  const err = new Error(message) as TaggedError
  err.status = res.status
  // 재시도 후에도 남은 429/5xx/레이트리밋 — 캠페인 failed 대신 다음 tick 재시도
  if (res.status === 429 || res.status >= 500 || (!!reason && DRIVE_RATE_REASONS.has(reason))) {
    err.transient = true
  }
  return err
}

async function driveGetMeta(
  accessToken: string,
  fileId: string,
): Promise<{ size: number | null; mimeType: string | null }> {
  // 삭제 여부 + 실시간 크기/타입 (Google 문서류는 size 없음)
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed,size,mimeType`
  const res = await driveFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await driveToError(res)
  const j = await res.json()
  if (j.trashed) {
    const err = new Error('File trashed') as Error & { status: number }
    err.status = 404
    throw err
  }
  const size = j.size != null && j.size !== '' ? Number(j.size) : null
  return {
    size: size != null && Number.isFinite(size) ? size : null,
    mimeType: typeof j.mimeType === 'string' ? j.mimeType : null,
  }
}

async function driveDownload(accessToken: string, fileId: string): Promise<Uint8Array> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
  const res = await driveFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await driveToError(res)
  return new Uint8Array(await res.arrayBuffer())
}

async function driveShareAsPublicLink(accessToken: string, fileId: string): Promise<string> {
  // 1) permission 추가: role=reader, type=anyone (재시도로 중복 생성돼도 같은 권한이라 무해)
  const permRes = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }
  )
  if (!permRes.ok) throw await driveToError(permRes)

  // 2) webViewLink 조회
  const metaRes = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=webViewLink`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!metaRes.ok) throw await driveToError(metaRes)
  const j = await metaRes.json()
  if (!j.webViewLink) throw new Error('Drive 링크를 가져올 수 없습니다.')
  return j.webViewLink as string
}

// ============================================================
// Base64 인코딩 — 룩업 테이블로 바이트 → ASCII 바이트를 직접 기록.
// String.fromCharCode/btoa 경유보다 수 배 빠르고 중간 문자열을 만들지 않는다
// (Edge CPU 한도 안에서 15MB 첨부를 run 당 1회 인코딩하기 위함).
//   wrap — MIME 본문용 76자 CRLF 줄바꿈 / url — base64url 알파벳 + 패딩 제거
// ============================================================
const B64_STD = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/')
const B64_URL = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_')
const ASCII_DECODER = new TextDecoder()

function base64Encode(u8: Uint8Array, opts: { wrap?: boolean; url?: boolean } = {}): Uint8Array {
  const T = opts.url ? B64_URL : B64_STD
  const n = u8.length
  const rem = n % 3
  const chars = opts.url ? Math.floor(n / 3) * 4 + (rem ? rem + 1 : 0) : Math.ceil(n / 3) * 4
  const breaks = opts.wrap && chars > 0 ? Math.ceil(chars / 76) - 1 : 0
  const out = new Uint8Array(chars + breaks * 2)
  let o = 0
  let col = 0
  let i = 0
  const full = n - rem
  for (; i < full; i += 3) {
    if (opts.wrap && col === 76) {
      out[o++] = 13
      out[o++] = 10
      col = 0
    }
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]
    out[o++] = T[v >> 18]
    out[o++] = T[(v >> 12) & 63]
    out[o++] = T[(v >> 6) & 63]
    out[o++] = T[v & 63]
    col += 4
  }
  if (rem) {
    if (opts.wrap && col === 76) {
      out[o++] = 13
      out[o++] = 10
    }
    const v = (u8[i] << 16) | (rem === 2 ? u8[i + 1] << 8 : 0)
    out[o++] = T[v >> 18]
    out[o++] = T[(v >> 12) & 63]
    if (rem === 2) out[o++] = T[(v >> 6) & 63]
    else if (!opts.url) out[o++] = 61
    if (!opts.url) out[o++] = 61
  }
  return out
}

function bytesToBase64(u8: Uint8Array): string {
  return ASCII_DECODER.decode(base64Encode(u8))
}

// ============================================================
// 링크 모드용 본문 섹션 (src/hooks/useSendCampaign.ts 와 동일 디자인)
// ============================================================
function buildLinkSection(items: PreparedAttachment[]): string {
  if (items.length === 0) return ''
  const listItems = items
    .map(
      (x) =>
        `<li style="margin:4px 0;"><a href="${escapeHtml(x.link ?? '')}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;">${escapeHtml(x.filename)}</a>${
          x.size != null ? ` <span style="color:#6b7280;font-size:12px;">(${formatBytes(x.size)})</span>` : ''
        }</li>`
    )
    .join('')
  return `
<hr style="margin:24px 0;border:0;border-top:1px solid #e5e7eb;"/>
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#111827;">
  <p style="margin:0 0 8px 0;"><strong>📎 첨부 파일</strong> <span style="color:#6b7280;font-size:12px;">(Google Drive 링크로 전달됩니다)</span></p>
  <ul style="padding-left:20px;margin:0;">${listItems}</ul>
</div>`.trim()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ------------------------------------------------------------
// Phase 6 (C) — 오픈 추적 픽셀 (src/hooks/useSendCampaign.ts 와 동일 로직)
// ------------------------------------------------------------
function buildTrackingPixel(recipientId: string, campaignId: string): string {
  const url = `${SUPABASE_URL}/functions/v1/track-open?rid=${encodeURIComponent(recipientId)}&cid=${encodeURIComponent(campaignId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

function injectTrackingPixel(html: string, pixelHtml: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  }
  return html + pixelHtml
}

// ------------------------------------------------------------
// 079 — 수신거부 footer + List-Unsubscribe (src/hooks/useSendCampaign.ts 와 동일 문구/로직)
// 정보통신망법 제50조 (본문 수신거부 방법 명시) + RFC 8058 one-click.
// footer 는 클릭 래핑 *이후* 붙인다 — track-click 리다이렉트를 거치면 안 됨.
// ------------------------------------------------------------
// C-2 — 본문 footer 링크: 사람용 수신거부 페이지 (SPA, GitHub Pages). 페이지가 POST {t} 로 처리.
function buildUnsubscribePageUrl(token: string | null | undefined): string | null {
  if (!token) return null
  return `${APP_BASE_URL}/unsubscribe?t=${encodeURIComponent(token)}`
}

// C-2 — List-Unsubscribe 헤더: RFC 8058 one-click POST 를 받는 Edge Function 직접 주소.
function buildOneClickUnsubscribeUrl(token: string | null | undefined): string | null {
  if (!token) return null
  return `${SUPABASE_URL}/functions/v1/unsubscribe?t=${encodeURIComponent(token)}`
}

// url 이 없으면 (일괄 발송 — 한 통을 여럿이 받아 수신자별 토큰 불가) 회신 수신거부 안내.
// 회신의 수신거부 의사는 check-replies 가 감지해 unsubscribes 에 등록한다.
function buildUnsubscribeFooter(url: string | null): string {
  const style = 'margin:24px 0 0 0;font-size:11px;line-height:1.5;color:#9ca3af;'
  if (url) {
    return `<p style="${style}">본 메일의 수신을 원하지 않으시면 <a href="${escapeHtml(url)}" style="color:#9ca3af;text-decoration:underline;">수신거부</a>를 눌러주세요.</p>`
  }
  return `<p style="${style}">본 메일의 수신을 원하지 않으시면 이 메일에 '수신거부'라고 회신해 주세요.</p>`
}

function appendUnsubscribeFooter(html: string, footerHtml: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footerHtml}</body>`)
  }
  return html + footerHtml
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ============================================================
// Gmail MIME 빌더 — src/lib/gmail.ts 의 Deno 포트
// 첨부 있으면 multipart/mixed, 없으면 text/html 단일 파트 (backward compat)
// ============================================================
interface MailAttachment {
  filename: string
  mimeType: string
  wrapped: Uint8Array // base64 ASCII 바이트, 76자 CRLF 줄바꿈 완료 (run 당 1회 인코딩)
}

interface GmailSendInput {
  accessToken: string
  from: string
  to: string
  // bulk — 여러 주소를 To 에 넣을 때 (헤더 folding 적용). 지정 시 to/toName 무시
  toList?: string[]
  toName?: string | null
  subject: string
  html: string
  cc?: string[]
  bcc?: string[]
  // 079 — List-Unsubscribe 헤더 URL (개별 발송 + 캠페인 CC/BCC 없음일 때만 — 수신자별 토큰, C-4)
  listUnsubscribeUrl?: string | null
}

interface InlineImage {
  cid: string
  filename: string
  mimeType: string
  wrapped: string // base64, 76자 CRLF 줄바꿈 완료 (run 당 1회)
  rawBytes: number
}

// 본문의 <img src="..."> 를 base64 inline 으로 embed.
// 클라이언트 (src/lib/inlineImages.ts) 와 동일한 정책 — data URL / https URL 모두 fetch.
const INLINE_FETCH_TIMEOUT_MS = 10_000
const INLINE_MAX_IMAGE_BYTES = 8 * 1024 * 1024
const INLINE_MAX_TOTAL_BYTES = 20 * 1024 * 1024

async function extractAndInlineImages(
  html: string,
): Promise<{ html: string; images: InlineImage[] }> {
  if (!/<img\b[^>]*\bsrc=/i.test(html)) {
    return { html, images: [] }
  }
  const imgRe = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi
  const sources = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(html)) !== null) {
    sources.add(m[3])
  }
  const srcList = [...sources]
  const results = await Promise.allSettled(srcList.map((s) => fetchInline(s)))
  const srcToCid = new Map<string, string>()
  const images: InlineImage[] = []
  let totalBytes = 0
  let index = 1
  for (let i = 0; i < srcList.length; i++) {
    const r = results[i]
    if (r.status !== 'fulfilled' || !r.value) continue
    const img = r.value
    if (img.rawBytes > INLINE_MAX_IMAGE_BYTES) continue
    if (totalBytes + img.rawBytes > INLINE_MAX_TOTAL_BYTES) continue
    totalBytes += img.rawBytes
    const cid = `mc-img-${index++}-${crypto.randomUUID().slice(0, 8)}`
    srcToCid.set(srcList[i], cid)
    images.push({
      cid,
      filename: img.filename,
      mimeType: img.mimeType,
      wrapped: wrapBase64(img.base64),
      rawBytes: img.rawBytes,
    })
  }
  const transformed = html.replace(imgRe, (full, before, _q, src, after) => {
    const cid = srcToCid.get(src)
    if (!cid) return full
    return `<img${before}src="cid:${cid}"${after}>`
  })
  return { html: transformed, images }
}

async function fetchInline(src: string): Promise<{
  filename: string
  mimeType: string
  base64: string
  rawBytes: number
} | null> {
  const dataMatch = src.match(/^data:([^;]+);base64,(.+)$/)
  if (dataMatch) {
    const mimeType = dataMatch[1]
    const base64 = dataMatch[2]
    const rawBytes = Math.ceil((base64.length * 3) / 4)
    return { filename: `inline.${extFromMime(mimeType)}`, mimeType, base64, rawBytes }
  }
  if (!/^https?:\/\//.test(src)) return null
  // SSRF 가드 — 서버가 대신 fetch 해서 결과를 메일에 되돌려주는 함수이므로,
  // 인라인(서버 fetch) 대상을 이 프로젝트의 Supabase Storage 공개 URL 로 한정한다.
  // (문서화된 사용처: 서명 이미지 버킷 — migration 044.)
  // 그 외 외부 이미지는 인라인하지 않고 <img src> 그대로 두면 수신자 메일
  // 클라이언트가 직접 로드하므로 기능 손실 없음. 내부망/메타데이터 주소로의
  // 서버측 GET(읽기 회신 포함)을 차단.
  const ownStoragePrefix = `${SUPABASE_URL}/storage/v1/object/public/`
  if (!src.startsWith(ownStoragePrefix)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INLINE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(src, { signal: controller.signal, redirect: 'error' })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? 'application/octet-stream'
    if (!ct.startsWith('image/')) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) return null
    const base64 = bytesToBase64(new Uint8Array(buf))
    const filename = filenameFromUrl(src) ?? `inline.${extFromMime(ct)}`
    return { filename, mimeType: ct, base64, rawBytes: buf.byteLength }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').pop()
    if (!last) return null
    return decodeURIComponent(last)
  } catch {
    return null
  }
}

function stripCRLF(s: string): string {
  // \ud5e4\ub354 \uc778\uc81d\uc158 \ubc29\uc9c0 \u2014 CR/LF/NUL/U+2028/U+2029 \uc81c\uac70. \uc758\ub3c4\ub41c \ucee8\ud2b8\ub864 \ubb38\uc790.
  // deno-lint-ignore no-control-regex
  return s.replace(/[\r\n\0\u2028\u2029]/g, '')
}

function encodeHeader(value: string): string {
  const clean = stripCRLF(value)
  // ASCII-only \uac80\uc0ac \u2014 RFC 2047 \uc778\ucf54\ub529 \ud544\uc694 \uc5ec\ubd80 \ud310\ub2e8. \uc758\ub3c4\ub41c \ucee8\ud2b8\ub864 \ubb38\uc790.
  // deno-lint-ignore no-control-regex
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean
  const enc = new TextEncoder()
  const MAX_BYTES = 42
  const parts: string[] = []
  let buf = ''
  let bufBytes = 0
  for (const ch of clean) {
    const chBytes = enc.encode(ch).length
    if (bufBytes + chBytes > MAX_BYTES && buf) {
      parts.push(`=?UTF-8?B?${utf8ToBase64(buf)}?=`)
      buf = ''
      bufBytes = 0
    }
    buf += ch
    bufBytes += chBytes
  }
  if (buf) parts.push(`=?UTF-8?B?${utf8ToBase64(buf)}?=`)
  return parts.join(' ')
}

function utf8ToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s))
}

function wrapBase64(s: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width))
  return chunks.join('\r\n')
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return ASCII_DECODER.decode(base64Encode(bytes, { url: true }))
}

function joinAddressList(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined
  const cleaned = list
    .map((a) => encodeAddressHeader(stripCRLF(a).trim()))
    .filter(Boolean)
  return cleaned.length > 0 ? foldAddressList(cleaned) : undefined
}

// 주소 목록 헤더 folding (RFC 5322 — 한 줄 998자 한도). 콤마 뒤 CRLF+SP 로 줄바꿈.
// 각 주소는 이미 stripCRLF 를 거쳤으므로 여기서 넣는 CRLF 만 존재한다.
function foldAddressList(items: string[]): string {
  let out = ''
  let lineLen = 4 // "To: " / "Cc: " 접두
  items.forEach((item, idx) => {
    if (idx === 0) {
      out = item
      lineLen += item.length
    } else if (lineLen + 2 + item.length > 76) {
      out += `,\r\n ${item}`
      lineLen = 1 + item.length
    } else {
      out += `, ${item}`
      lineLen += 2 + item.length
    }
  })
  return out
}

/**
 * 본문에 시그니처가 이미 포함됐는지 plain-text fragment 로 판정.
 * src/lib/mailMerge.ts 의 bodyAlreadyContainsSignature 와 동일 정책 (즉시/예약 발송 일치).
 * (edge 런타임이라 lib import 불가 — 포트.)
 */
function bodyContainsSignature(bodyHtml: string, sigHtml: string): boolean {
  const strip = (h: string) =>
    h
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const bodyPlain = strip(bodyHtml)
  const sigPlain = strip(sigHtml)
  if (!sigPlain) return true
  if (sigPlain.length < 40) return bodyPlain.includes(sigPlain)
  return bodyPlain.includes(sigPlain.slice(0, 80))
}

/**
 * 주소 헤더 (From/Cc/Bcc 등) 의 display name 만 RFC 2047 인코딩.
 * 받는 클라이언트가 한글 등 비-ASCII 이름을 mojibake 로 표시하지 않도록.
 */
function encodeAddressHeader(addr: string): string {
  const m = addr.match(/^\s*(.+?)\s*<([^>]+)>\s*$/)
  if (!m) return addr
  const name = m[1].trim().replace(/^"(.*)"$/, '$1')
  const email = m[2].trim()
  if (!name) return `<${email}>`
  // deno-lint-ignore no-control-regex
  if (/^[\x20-\x7E]+$/.test(name)) {
    // RFC 5322 specials 가 하나라도 있으면 quoted-string 필수 — [ ] 는 unquoted phrase 에서
    // 무효(Gmail 400), ( ) 는 주석으로 해석돼 이름이 잘림.
    if (!/[()<>[\]:;@\\,."]/.test(name)) return `${name} <${email}>`
    // ASCII 특수문자(콤마 등) — quoted-string 필수. encodeHeader 는 ASCII 를 그대로 반환.
    return `"${name.replace(/([\\"])/g, '\\$1')}" <${email}>`
  }
  return `${encodeHeader(name)} <${email}>`
}

// RFC 5987 / 2231 — 비-ASCII filename 파라미터
function encodeRFC2231(value: string): string {
  return `UTF-8''${encodeURIComponent(value).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/**
 * filename / name 파라미터 — 한글 등 비-ASCII 파일명이 Gmail UI 에서 underscore
 * 로 깨지지 않도록. filename= 에 RFC 2047 encoded-word (=?UTF-8?B?...?=) 사용.
 * 비표준이지만 Gmail/Outlook/Apple Mail 모두 디코딩하는 de-facto 표준.
 * filename*= (RFC 5987) 도 함께 — 표준 따르는 신형 클라이언트 우선용.
 */
function dispositionFilename(filename: string): string {
  const clean = stripCRLF(filename)
  // deno-lint-ignore no-control-regex
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `filename="${clean}"`
  return `filename="${encodeOneWordForParam(clean)}"; filename*=${encodeRFC2231(clean)}`
}

function contentTypeName(filename: string): string {
  const clean = stripCRLF(filename)
  // deno-lint-ignore no-control-regex
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `name="${clean}"`
  return `name="${encodeOneWordForParam(clean)}"; name*=${encodeRFC2231(clean)}`
}

// 짧은 문자열용 single encoded-word (75자 한도 안에 들어가는 일반 파일명에는 충분).
function encodeOneWordForParam(s: string): string {
  return `=?UTF-8?B?${utf8ToBase64(s)}?=`
}

// 수신자와 무관한 MIME 뒷부분(inline 이미지 + 첨부 파트 + 닫는 boundary).
// run 당 1회 만들어 Blob 으로 공유 — 수신자별로는 헤더+본문(head)만 새로 만들고
// Blob([head, tail]) 로 이어붙인다 (Blob 파트는 참조라 대용량 복사/재인코딩 없음).
// boundary 는 run 단위 고정 — '_' 가 base64 알파벳에 없어 본문/첨부와 충돌하지 않는다.
interface MimeTail {
  top: string
  inner: string | null
  hasInline: boolean
  hasAttachments: boolean
  blob: Blob
}

// 수신자별 최종 HTML 이 실제로 참조하는 inline 이미지(cid:)만 담은 tail 을 돌려주는 팩토리.
// (개인화 override 본문은 공통 본문의 이미지를 참조하지 않는 경우가 많다 — 미참조 related 파트는
//  메일 클라이언트에서 이름 없는 첨부(inline.png)로 보인다. 클라이언트 gmail.ts 와 동일 정책.)
// 첨부 파트 Blob 과 이미지 파트 Blob 은 run 당 1회만 만들고, 조합별 tail 은 그 Blob 들을
// 참조만 하므로 (복사 없음) 조합 수가 늘어도 메모리가 크게 늘지 않는다. 조합별로 캐시.
interface MimeTailFactory {
  forHtml(html: string): MimeTail | null
  // 모든 inline 이미지를 포함했을 때의 tail 크기 — 예산/타임아웃 추정용 상한
  maxBytes: number
}

function createMimeTailFactory(
  attachments: MailAttachment[] | undefined,
  inlineImages: InlineImage[] | undefined,
): MimeTailFactory {
  const images = inlineImages ?? []
  const hasAttachments = !!attachments && attachments.length > 0
  const newBoundary = () => `MC_${crypto.randomUUID().replace(/-/g, '')}`
  const top = newBoundary()
  // 일반 첨부가 있으면 본문/inline 묶음을 multipart/related(inner) 로, 그걸 multipart/mixed(top) 로 감쌈.
  // inline 만 있으면 top-level 이 multipart/related.
  const innerBoundary = newBoundary()
  const imgBoundary = hasAttachments ? innerBoundary : top
  const imgBlobs = images.map(
    (img) =>
      new Blob([
        [
          `--${imgBoundary}`,
          `Content-Type: ${img.mimeType}; ${contentTypeName(img.filename)}`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: inline; ${dispositionFilename(img.filename)}`,
          `Content-ID: <${img.cid}>`,
          '',
          img.wrapped,
        ].join('\r\n') + '\r\n',
      ]),
  )
  let attachBlob: Blob | null = null
  if (hasAttachments) {
    const parts: BlobPart[] = []
    for (const att of attachments!) {
      parts.push(
        [
          `--${top}`,
          `Content-Type: ${att.mimeType || 'application/octet-stream'}; ${contentTypeName(att.filename)}`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; ${dispositionFilename(att.filename)}`,
          '',
          '',
        ].join('\r\n'),
      )
      parts.push(att.wrapped as unknown as BlobPart)
      parts.push('\r\n')
    }
    attachBlob = new Blob(parts)
  }

  const build = (idx: number[]): MimeTail | null => {
    const hasInline = idx.length > 0
    if (!hasInline && !hasAttachments) return null
    const inner = hasAttachments && hasInline ? innerBoundary : null
    const parts: BlobPart[] = idx.map((i) => imgBlobs[i])
    if (inner) parts.push(`--${inner}--\r\n`)
    if (attachBlob) parts.push(attachBlob)
    parts.push(`--${top}--\r\n`)
    return { top, inner, hasInline, hasAttachments, blob: new Blob(parts) }
  }

  const allIdx = images.map((_, i) => i)
  const full = build(allIdx)
  const cache = new Map<string, MimeTail | null>([[allIdx.join(','), full]])
  return {
    maxBytes: full?.blob.size ?? 0,
    forHtml(html: string): MimeTail | null {
      const idx = allIdx.filter((i) => html.includes(`cid:${images[i].cid}`))
      const key = idx.join(',')
      if (!cache.has(key)) cache.set(key, build(idx))
      return cache.get(key) ?? null
    },
  }
}

// 수신자별 MIME 앞부분 — 헤더 + HTML 본문 파트. tail 이 없으면 단일 text/html 메시지 전체.
function buildMimeHead(input: Omit<GmailSendInput, 'accessToken'>, tail: MimeTail | null): string {
  const { from, to, toList, toName, subject, html, cc, bcc, listUnsubscribeUrl } = input
  const cleanFrom = encodeAddressHeader(stripCRLF(from))
  const cleanTo = stripCRLF(to)
  const ccLine = joinAddressList(cc)
  const bccLine = joinAddressList(bcc)
  // 표시 이름은 encodeAddressHeader 경유 — ASCII 특수문자(콤마 등) quoted-string 처리
  const toHeader = toList && toList.length > 0
    ? foldAddressList(toList.map((a) => stripCRLF(a).trim()).filter(Boolean))
    : toName
    ? encodeAddressHeader(`${stripCRLF(toName).replace(/[<>]/g, '')} <${cleanTo}>`)
    : cleanTo
  const bodyBase64 = ASCII_DECODER.decode(base64Encode(new TextEncoder().encode(html), { wrap: true }))

  const baseHeaders: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (ccLine) baseHeaders.push(`Cc: ${ccLine}`)
  if (bccLine) baseHeaders.push(`Bcc: ${bccLine}`)
  // RFC 8058 — Gmail/Yahoo 대량 발신자 요건. https URL 만 (꺾쇠/공백/CRLF 제거 후)
  const cleanUnsub = listUnsubscribeUrl ? stripCRLF(listUnsubscribeUrl).replace(/[<>\s]/g, '') : ''
  if (/^https:\/\//i.test(cleanUnsub)) {
    baseHeaders.push(`List-Unsubscribe: <${cleanUnsub}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  baseHeaders.push(`Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0')

  const htmlPartHeaders = ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64']

  // 둘 다 없으면 단일 text/html
  if (!tail) {
    return [...baseHeaders, ...htmlPartHeaders].join('\r\n') + '\r\n\r\n' + bodyBase64
  }

  if (!tail.hasAttachments) {
    const headers = [...baseHeaders, `Content-Type: multipart/related; boundary="${tail.top}"`]
    return headers.join('\r\n') + '\r\n\r\n' +
      [`--${tail.top}`, ...htmlPartHeaders, '', bodyBase64].join('\r\n') + '\r\n'
  }

  const headers = [...baseHeaders, `Content-Type: multipart/mixed; boundary="${tail.top}"`]
  const lines: string[] = [`--${tail.top}`]
  if (tail.inner) {
    lines.push(`Content-Type: multipart/related; boundary="${tail.inner}"`, '', `--${tail.inner}`)
  }
  lines.push(...htmlPartHeaders, '', bodyBase64)
  return headers.join('\r\n') + '\r\n\r\n' + lines.join('\r\n') + '\r\n'
}

// 수신자 1통의 RFC822 메시지 (Blob). 첨부/inline 은 tail Blob 을 참조만 한다.
function encodeMime(input: Omit<GmailSendInput, 'accessToken'>, tail: MimeTail | null): Blob {
  const head = buildMimeHead(input, tail)
  return new Blob(tail ? [head, tail.blob] : [head])
}

const GMAIL_QUOTA_REASONS = new Set(['dailyLimitExceeded', 'quotaExceeded'])
const GMAIL_RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])
const GMAIL_FATAL_403_REASONS = new Set(['insufficientPermissions', 'domainPolicy', 'forbidden'])

// Gmail 오류 분류 — reason(error.errors[0].reason) / status / message 기준.
function classifyGmailFailure(
  httpStatus: number,
  reason: string | undefined,
  apiStatus: string | undefined,
  message: string,
): GmailErrorKind {
  if (
    (reason && GMAIL_QUOTA_REASONS.has(reason)) ||
    /daily user sending quota exceeded|limit exceeded for sending|sending limit exceeded|\(mail sending\)/i
      .test(message)
  ) {
    return 'quota'
  }
  if (
    httpStatus === 429 ||
    (reason && GMAIL_RATE_REASONS.has(reason)) ||
    apiStatus === 'RESOURCE_EXHAUSTED'
  ) {
    return 'rate'
  }
  // 계정 전체 오류 — 수신자를 바꿔도 똑같이 실패한다 (C-6).
  // 401 은 sendWithRetry 가 토큰 갱신 1회 후 판정하므로 여기서는 다루지 않는다.
  if (httpStatus === 403 && reason && GMAIL_FATAL_403_REASONS.has(reason)) return 'fatal'
  if (
    httpStatus === 400 &&
    (reason === 'failedPrecondition' || apiStatus === 'FAILED_PRECONDITION' ||
      /mail service not enabled/i.test(message))
  ) {
    return 'fatal'
  }
  if (httpStatus >= 500) return 'transient'
  return 'permanent'
}

// 403/400 fatal 사유 → 사용자 안내 문구
function fatalGmailMessage(httpStatus: number, reason: string | undefined, message: string): string {
  if (httpStatus === 400) {
    return `이 Google 계정에서 Gmail 을 사용할 수 없습니다 (Gmail 서비스 미사용/비활성). Google Workspace 관리자에게 확인해 주세요. (${message})`
  }
  if (reason === 'domainPolicy') {
    return `조직(도메인) 정책으로 Gmail API 발송이 차단되었습니다. Google Workspace 관리자에게 확인해 주세요. (${message})`
  }
  return `Gmail 발송 권한이 없습니다. Google 계정을 다시 연결해 발송 권한을 허용해 주세요. (${message})`
}

// Retry-After 헤더(초 또는 HTTP-date) 또는 메시지의 "Retry after <ISO>" → epoch ms
function parseRetryAt(header: string | null, message: string): number | null {
  if (header) {
    const secs = Number(header)
    if (Number.isFinite(secs)) return Date.now() + secs * 1000
    const d = Date.parse(header)
    if (!Number.isNaN(d)) return d
  }
  const m = message.match(/retry after\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i)
  if (m) {
    const d = Date.parse(m[1])
    if (!Number.isNaN(d)) return d
  }
  return null
}

async function sendGmailRaw(
  accessToken: string,
  mime: Blob,
  timeoutMs = 25_000,
): Promise<{ id: string; threadId: string }> {
  // 작은 메시지는 JSON {raw}, 큰 메시지는 /upload (message/rfc822, 최대 35MB) —
  // JSON 엔드포인트는 요청 크기 한도가 작고 base64 이중 인코딩으로 1.8배 커진다.
  const rawChars = Math.ceil(mime.size / 3) * 4
  const useUpload = rawChars > GMAIL_JSON_RAW_MAX_CHARS
  const jsonBody = useUpload
    ? null
    : JSON.stringify({ raw: bytesToBase64Url(new Uint8Array(await mime.arrayBuffer())) })
  // 명시적 타임아웃 — Gmail 이 hang 하면 RUN_BUDGET_MS(50초) 안에 다른
  // recipient 처리를 못 하고 함수가 통째로 죽음. 호출자가 남은 예산으로 clamp 해
  // 넘기면 run 예산을 넘겨 Edge hard timeout(60초) 에 걸리는 오버슛도 방지.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = useUpload
      ? await fetch(
          'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'message/rfc822',
            },
            body: mime,
            signal: controller.signal,
          },
        )
      : await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: jsonBody,
          signal: controller.signal,
        })
  } catch (e) {
    const detail = (e as Error)?.name === 'AbortError'
      ? `타임아웃 ${Math.round(timeoutMs / 1000)}초 초과`
      : errMessage(e)
    // 연결 수립 자체가 실패(DNS/TCP connect/TLS 핸드셰이크) — 요청 바이트가 나가기 전이라
    // 발송되지 않은 것이 확정. pending 복귀는 안전하지만 run 안 재시도는 하지 않는다.
    if ((e as Error)?.name !== 'AbortError' && isPreSendNetworkError(e)) {
      const err = new Error(`Gmail API 연결 실패: ${detail}`) as TaggedError
      err.kind = 'transient'
      err.preSend = true
      throw err
    }
    // 그 외 네트워크 오류/타임아웃 — 요청이 이미 전송돼 Gmail 이 발송했을 수 있다.
    // 재시도·pending 복귀 금지 (중복 발송 방지). status 를 두지 않는다 (= Gmail 응답 없음).
    const err = new Error(`${UNCERTAIN_SEND_MESSAGE} (${detail})`) as TaggedError
    err.kind = 'ambiguous'
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let message = `Gmail API ${res.status}`
    let reason: string | undefined
    let apiStatus: string | undefined
    try {
      const j = JSON.parse(body)
      message = j?.error?.message || message
      reason = j?.error?.errors?.[0]?.reason
      apiStatus = j?.error?.status
    } catch {
      if (body) message = body
    }
    const kind = classifyGmailFailure(res.status, reason, apiStatus, message)
    const err = new Error(kind === 'fatal' ? fatalGmailMessage(res.status, reason, message) : message) as TaggedError
    err.status = res.status
    err.kind = kind
    err.retryAt = parseRetryAt(res.headers.get('retry-after'), message)
    throw err
  }
  try {
    return await res.json()
  } catch (e) {
    // 2xx 를 받았지만 응답 본문을 못 읽음 — 발송은 됐을 가능성이 높다. 재시도 금지.
    const err = new Error(`${UNCERTAIN_SEND_MESSAGE} (응답 해석 실패: ${errMessage(e)})`) as TaggedError
    err.kind = 'ambiguous'
    throw err
  }
}

// Deno fetch 의 연결 수립 단계 오류 (hyper "error trying to connect: dns error / tcp connect
// error / Connection refused / TLS handshake") — 이 단계에서는 요청이 서버에 도달하지 않는다.
function isPreSendNetworkError(e: unknown): boolean {
  const msg = errMessage(e)
  return /error trying to connect|dns error|failed to lookup address|connection refused/i.test(msg)
}
