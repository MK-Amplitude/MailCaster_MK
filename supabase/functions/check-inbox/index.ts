// Supabase Edge Function: check-inbox
// ============================================================
// 역할
// ------------------------------------------------------------
// pg_cron 이 매 5분 POST /functions/v1/check-inbox 로 호출.
// 사용자별 Gmail inbox 폴링 → contact 매칭 inbound 메일 감지 → DB 기록.
//
// 매칭 정책:
//   - From 헤더 이메일이 contacts.email (같은 org) 와 매칭 → 그 contact 의 inbound 으로 기록
//   - 매칭 없음 → contact 자동 생성 후 기록.
//     단 자동 발송/대량 메일은 inbound 로만 기록하고 contact 는 만들지 않음 (isAutomatedMessage).
//     뉴스레터마다 contacts·audit 행이 쌓이던 문제. 판정은 강한 신호 (noreply 류 주소,
//     Auto-Submitted, Precedence: bulk/junk, 프로모션·소셜 카테고리) 단독, 또는 약한 신호
//     (메일링리스트 헤더·포럼 카테고리 / 업데이트 카테고리 / Feedback-ID) 두 종류 이상일 때만.
//     Google Groups·공동 받은편지함 (sales@, contact@) 이 실제 고객 메일에 List-Id 등을 붙이므로
//     리스트 헤더 하나만으로는 자동 메일로 보지 않음 (신규 리드 contact 누락 방지).
//
// Incremental 폴링 (두 경로, 둘 다 "실제로 처리한 지점까지만" 커서 전진):
//   - History API (profiles.last_history_id) — 델타. 오래된 record 부터 처리하고,
//     모든 메시지를 처리한 마지막 history record id 까지만 전진.
//   - 시간기반 폴백 (profiles.last_inbox_check_at) — 첫 실행/History 만료 시.
//     `after:<cursor>` 결과를 nextPageToken 으로 끝까지 모아 **오래된 순**으로 처리.
//     처리 못 한 메시지가 남으면 커서는 마지막 처리분 직전에 머묾 → 다음 tick 이 이어받음.
//     (Gmail list 는 최신순이라 예전엔 최신 100통만 보고 커서를 넘겨 오래된 메일이 영구 누락됐음)
//   처음 실행 (NULL) 이면 최근 24시간만 (대량 backfill 방지).
//
// 보안:
//   Authorization: Bearer <CRON_SECRET>  (pg_cron 주입)
//
// 타임아웃 복원력 / 공정성:
//   - 사용자당 한 tick 에 최대 PER_USER_MAX_MESSAGES 통만 fetch — 나머지는 다음 tick 이월.
//   - 이미 기록된 gmail_message_id 는 청크당 1회 조회로 걸러 Gmail fetch 자체를 생략.
//   - 발견 단계 (토큰 갱신·목록·창 좁히기) 는 사용자당 시간 (DISCOVERY_MAX_MS)·호출 수
//     (MAX_DISCOVERY_CALLS) 상한. 발견이 끝나면 처리 마감 = max(시간 슬라이스, now + MIN_PROCESS_MS)
//     (run 예산 이내) — 목록 조회가 슬라이스를 다 써서 아무것도 처리 못 하고 같은 조회만
//     반복하던 livelock 방지.
//   - 처리 순서: 일반 사용자 (History 경로 / 최근 커서) 먼저, 백로그 사용자 (시간기반 커서가
//     BACKLOG_THRESHOLD_MS 이상 과거) 는 그 뒤. 백로그 사용자가 있으면 일반 사용자 구간은
//     BACKLOG_RESERVE_MS 를 남기고 끝냄 → 양쪽 모두 매 tick 진전. 백로그 사용자끼리는 tick 번호
//     기준 라운드로빈 회전 (DB 컬럼 없이 결정적으로 공정).
//   - 모든 Gmail/OAuth 호출에 타임아웃 (CALL_TIMEOUT_MS, 마감까지 남은 시간으로 추가 제한).
//     호출이 멈춰도 그 사용자 진행분은 항상 저장.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decryptToken } from '../_shared/tokenCrypto.ts'
import { isCronAuthorized } from '../_shared/cronAuth.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

// 한 tick 최대 실행 시간 (ms). pg_cron 55s 컷 직전 자진 종료.
const RUN_BUDGET_MS = 50_000
// 사용자당 한 tick 최대 fetch 메시지 수 — 대형 inbox 의 backlog 는 cron 여러 tick 으로 나눔.
// (이미 기록된 메시지는 dedup 으로 걸러지므로 이 한도에 포함되지 않음)
const PER_USER_MAX_MESSAGES = 25
// 처음 실행 (last_inbox_check_at NULL) 시 최근 N 시간만 폴링 — 과거 모든 메일 backfill 방지
const INITIAL_LOOKBACK_HOURS = 24
// 한 메시지 (배치) fetch 평균 예산
const MESSAGE_FETCH_BUDGET_MS = 1_500
// 발견 (목록 조회) 이 끝난 뒤 사용자마다 보장하는 최소 처리 시간
const MIN_PROCESS_MS = 4_000
// 사용자 1명을 시작하려면 필요한 최소 잔여 예산 (토큰 갱신 + 목록 조회 + 최소 처리 + 커서 저장)
const USER_MIN_BUDGET_MS = 6_000
// 사용자별 시간 슬라이스 하한
const MIN_USER_SLICE_MS = 6_000
// 사용자당 발견 단계 상한 — 시간 / Gmail 호출 수 (getProfile + probe + 창 좁히기 + 페이지)
const DISCOVERY_MAX_MS = 10_000
const MAX_DISCOVERY_CALLS = 36
// 백로그 사용자 판정 — 시간기반 경로이면서 커서가 이만큼 과거 (History 404 폴백, 토큰 장기 단절 등)
const BACKLOG_THRESHOLD_MS = 30 * 60_000
// 백로그 사용자가 있을 때 일반 사용자 구간이 남겨 두는 run 예산
const BACKLOG_RESERVE_MS = 15_000
// pg_cron 호출 주기 — 백로그 사용자 라운드로빈 회전 기준 (tick 번호)
const CRON_PERIOD_MS = 5 * 60_000
// Gmail / OAuth 호출 1건 타임아웃 — 실제 값은 min(이 값, 마감까지 남은 시간), 하한 MIN_CALL_TIMEOUT_MS
const CALL_TIMEOUT_MS = 9_000
const MIN_CALL_TIMEOUT_MS = 1_000
// 메시지 fetch + 기록 동시 실행 수 (Gmail 사용자별 rate limit 과 nano DB 를 고려해 보수적으로)
const FETCH_CONCURRENCY = 4
// 목록(id) 페이지 크기 / 창 끝까지 페이지할 때의 id 상한
const LIST_ID_CAP = 2_000
const LIST_PAGE_SIZE = 500
// 시간기반 목록이 한 페이지를 넘으면 커서에서부터 before: 창을 키워 가며 (갤럽) 잘리는 지점을 찾고,
// 그 구간을 이분 탐색해 가장 오래된 구간부터 드레인 (narrowWindow).
//   갤럽: 60초 × 16^k — 6단계면 34년. 백로그 드레인 중에는 다음 미처리 메일이 커서 바로 뒤라 보통 1~3회.
//   이분: 잘린 상한까지 최대 log2(창) 단계. 합계 30단계면 어떤 커서든 MIN_WINDOW_SEC 까지 도달
//   → 단계 수가 아닌 최소 창 (와 발견 예산) 이 유일한 한계.
const MAX_WINDOW_NARROW_STEPS = 30
const GALLOP_START_SEC = 60
const GALLOP_FACTOR = 16
// 최소 창 (초). 커서는 창 끝 1초 전으로 가므로 2초 이상이어야 항상 전진.
const MIN_WINDOW_SEC = 2
// 경계 탐색 조기 종료 — 이만큼 id 가 들어오는 완전 목록 창이면 이번 tick 처리량으로 충분
const NARROW_ENOUGH_IDS = 100
// History API 페이지 상한 (페이지당 최대 500 record)
const HISTORY_MAX_PAGES = 5
// 기존 gmail_message_id 일괄 조회 청크 크기 (PostgREST URL 길이 보호)
const DEDUP_CHUNK = 100
// 같은 메시지 기록이 계속 실패해 커서가 영구히 묶이지 않도록 — 수신 후 이 시간이 지났고
// 같은 tick 에 다른 메시지 기록은 성공했다면 (= 시스템 장애가 아닌 해당 메시지 문제) 포기하고 넘어감.
const RECORD_GIVEUP_AGE_MS = 24 * 3600_000
// body_html 저장 상한 (UTF-8 바이트). 초과 시 NULL — UI 는 body_text(8000자 cap) 만 사용하고
// inbound body_html 은 렌더하지 않음 (XSS 방지). 잘라 저장하면 깨진 HTML 이 되므로 NULL.
const BODY_HTML_MAX_BYTES = 100_000
// 시간기반 드레인 완료 시 커서 겹침 — 검색 인덱스 지연 대비. 중복은 dedup/UNIQUE 가 흡수.
const CURSOR_OVERLAP_MS = 60_000

// 자동 발송/대량 메일 판정 — contact 자동 생성 제외용 (isAutomatedMessage)
//   강한 신호 카테고리: 단독으로 자동 메일
const STRONG_AUTOMATED_CATEGORY_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']
const AUTOMATED_LOCAL_PART_RE =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?|bounces?)([-+_.].*)?$/i

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  snippet?: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
  } & GmailPart
}

// Gmail API HTTP 오류 — status 로 404(만료/삭제)·일시 오류를 구분하기 위함
class GmailHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// Gmail / OAuth 호출 타임아웃 — 일시 오류로 취급 (해당 메시지/단계만 미처리, 커서는 처리분까지 저장)
class CallTimeoutError extends Error {}

interface RunStats {
  processed: number
  recorded: number
  contactsCreated: number
  contactsSuppressed: number
  skippedExisting: number
  gmailErrors: number
  recordErrors: number
}

// 메시지 1통 처리 결과.
//   handled=true  → 커서가 이 메시지를 넘어가도 됨 (기록 성공 / 이미 기록됨 / 의도적 skip)
//   handled=false → 미처리 (한도·예산 초과로 손대지 않음, 또는 일시 오류) — 커서는 이 앞에 머묾
interface MsgOutcome {
  handled: boolean
  ts: number | null
  recordFailed?: boolean
  // record_inbound_message RPC 가 성공했음 (독 메시지 포기 판정용)
  recordOk?: boolean
}

interface UserCtx {
  supabase: AdminClient
  accessToken: string
  orgId: string
  userId: string
  userEmailLower: string
  // run 전체 마감 (epoch ms)
  runDeadline: number
  // 공정 분배 슬라이스 마감 — 사용자 시작 시각 + sliceMs
  sliceDeadline: number
  // 발견 단계 (목록·history·getProfile) 마감 / 남은 호출 수
  discoveryDeadline: number
  discoveryCallsLeft: number
  // 메시지 처리 마감 — 발견이 끝나면 startProcessing() 이 max(슬라이스, now + MIN_PROCESS_MS) 로 확정
  deadline: number
  stats: RunStats
}

type ProfileRow = {
  id: string
  email: string
  google_refresh_token: string
  last_inbox_check_at: string | null
  last_history_id: string | null
  default_org_id: string | null
}

// service_role 클라이언트 — 타입은 실제 인스턴스에서 유도 (generic 기본값 불일치 방지)
function createAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
type AdminClient = ReturnType<typeof createAdminClient>

type ProfileUpdate = { last_inbox_check_at?: string; last_history_id?: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!CRON_SECRET) return json({ error: 'CRON_SECRET not configured' }, 500)
  const auth = req.headers.get('Authorization') ?? ''
  if (!isCronAuthorized(auth, CRON_SECRET)) return json({ error: 'unauthorized' }, 401)

  const supabase = createAdminClient()

  const runStartedAt = Date.now()
  const runDeadline = runStartedAt + RUN_BUDGET_MS

  try {
    // 1) Google 토큰 보유한 모든 user 가져오기
    //    오래 전에 체크된 사용자부터 처리 (rotating cursor) — 정렬 없이 테이블 순서로 돌면
    //    예산 소진 break 때문에 뒤쪽 사용자가 영원히 폴링되지 않는 starvation 발생.
    const { data: profiles, error: pErr } = await supabase
      .schema('mailcaster')
      .from('profiles')
      .select('id, email, google_refresh_token, last_inbox_check_at, last_history_id, default_org_id')
      .not('google_refresh_token', 'is', null)
      .order('last_inbox_check_at', { ascending: true, nullsFirst: true })

    if (pErr) throw pErr
    const candidates = (profiles ?? []) as ProfileRow[]

    // org 미설정 (stub) 사용자는 처리 대상 아님 — 슬라이스 분모에서도 제외
    const active = candidates.filter((p) => p.default_org_id)

    // 2) 처리 순서 — 일반 사용자 먼저, 백로그 사용자는 뒤 (공정성).
    //    시간기반 백로그 사용자는 커서 (= 메시지 시각) 가 과거라 last_inbox_check_at 순으로는
    //    항상 맨 앞이 되어, 큰 백로그 한 명이 매 tick 예산을 다 쓰면 나머지가 굶었음.
    //    - 일반: last_inbox_check_at 오름차순 그대로 (History 경로는 드레인마다 조회 시각으로
    //      갱신되므로 자연히 회전).
    //    - 백로그: tick 번호 (runStartedAt / CRON_PERIOD_MS) 로 시작 위치를 회전하는 라운드로빈.
    //      새 DB 컬럼 없이 결정적이고, 백로그 사용자가 여럿이어도 매 tick 다른 사용자가 먼저 감.
    //    - 백로그 사용자가 있으면 일반 구간은 BACKLOG_RESERVE_MS 를 남기고 끝냄 (일반 사용자가
    //      아무리 많아도 백로그 사용자도 매 tick 진전). 못 돈 일반 사용자는 다음 tick 맨 앞.
    const normalUsers = active.filter((p) => !isBacklogged(p, runStartedAt))
    const backlogUsers = active.filter((p) => isBacklogged(p, runStartedAt))
    const rot = backlogUsers.length > 0
      ? Math.floor(runStartedAt / CRON_PERIOD_MS) % backlogUsers.length
      : 0
    const queue = normalUsers.concat(backlogUsers.slice(rot), backlogUsers.slice(0, rot))
    const normalGroupDeadline = backlogUsers.length > 0
      ? runDeadline - BACKLOG_RESERVE_MS
      : runDeadline

    const stats: RunStats = {
      processed: 0,
      recorded: 0,
      contactsCreated: 0,
      contactsSuppressed: 0,
      skippedExisting: 0,
      gmailErrors: 0,
      recordErrors: 0,
    }
    let tokenErrors = 0
    let usersPolled = 0
    let usersDeferred = 0

    for (let idx = 0; idx < queue.length; idx++) {
      const profile = queue[idx]
      const inNormalGroup = idx < normalUsers.length
      const groupDeadline = inNormalGroup ? normalGroupDeadline : runDeadline
      const usersLeftInGroup = inNormalGroup ? normalUsers.length - idx : queue.length - idx
      const remainingMs = groupDeadline - Date.now()
      if (remainingMs < USER_MIN_BUDGET_MS) {
        // 이 구간 예산 소진 — 일반 구간이면 백로그 구간으로 넘어감 (다음 tick 에 이어서)
        usersDeferred++
        continue
      }
      const orgId = profile.default_org_id!

      // 공정 분배 — 이 구간 남은 예산을 남은 사용자 수로 나눈 만큼 (하한 MIN_USER_SLICE_MS).
      // 일찍 끝난 사용자의 잔여 시간은 다음 사용자 몫 계산에 자연히 반영됨.
      const sliceMs = Math.max(MIN_USER_SLICE_MS, Math.floor(remainingMs / usersLeftInGroup))
      const sliceDeadline = Math.min(runDeadline, Date.now() + sliceMs)

      let accessToken: string
      try {
        accessToken = await refreshGoogleToken(
          profile.google_refresh_token,
          runDeadline - MIN_PROCESS_MS,
        )
      } catch (e) {
        tokenErrors++
        console.warn(
          '[check-inbox] token refresh failed uid=',
          profile.id,
          e instanceof Error ? e.message : e,
        )
        continue
      }

      const ctx: UserCtx = {
        supabase,
        accessToken,
        orgId,
        userId: profile.id,
        userEmailLower: profile.email.toLowerCase(),
        runDeadline,
        sliceDeadline,
        // 발견 단계는 최소 처리 시간을 남기고, 사용자당 DISCOVERY_MAX_MS 이내
        discoveryDeadline: Math.min(runDeadline - MIN_PROCESS_MS, Date.now() + DISCOVERY_MAX_MS),
        discoveryCallsLeft: MAX_DISCOVERY_CALLS,
        deadline: sliceDeadline,
        stats,
      }

      // 3) 메시지 발견: History API 우선(델타), 실패/미보유 시 시간기반 폴백.
      //    두 경로 모두 처리 후 반드시 커서를 저장 (예산 소진·호출 타임아웃 시에도 진행분 보존).
      try {
        let needTimeBased = !profile.last_history_id
        if (profile.last_history_id) {
          needTimeBased = !(await pollViaHistory(ctx, profile.last_history_id))
        }
        if (needTimeBased) {
          await pollViaTime(ctx, profile.last_inbox_check_at)
        }
        usersPolled++
      } catch (e) {
        stats.gmailErrors++
        console.warn(
          '[check-inbox] poll fail uid=',
          profile.id,
          e instanceof Error ? e.message : e,
        )
      }
    }

    return json({
      users: candidates.length,
      users_polled: usersPolled,
      users_backlog: backlogUsers.length,
      users_deferred: usersDeferred,
      processed: stats.processed,
      recorded: stats.recorded,
      skipped_existing: stats.skippedExisting,
      contacts_created: stats.contactsCreated,
      contacts_suppressed: stats.contactsSuppressed,
      token_errors: tokenErrors,
      gmail_errors: stats.gmailErrors,
      record_errors: stats.recordErrors,
      elapsed_ms: Date.now() - runStartedAt,
    })
  } catch (e) {
    console.error('[check-inbox] fatal:', e instanceof Error ? e.message : e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// ============================================================
// 폴링 경로
// ============================================================

/**
 * History API 경로. 반환 false = 시간기반 폴백 필요 (historyId 만료/오류).
 *
 * 커서 규칙 (C2 — History 델타는 재조회가 안 되므로 미처리분을 넘기면 영구 유실):
 *   - 전부 처리 + 목록이 잘리지 않음 → 응답 historyId 로 전진, 폴백 시계(last_inbox_check_at) = 조회 시각
 *   - 전부 처리 + 목록이 잘림(페이지/개수/발견 예산 상한) → 수집한 마지막 record id 로 전진
 *   - 미처리 남음 → "미처리 메시지가 처음 등장한 record" 바로 앞 record id 까지만 전진
 *     (이미 처리한 뒤쪽 메시지는 다음 tick 에 dedup 으로 비용 없이 걸러짐)
 *   부분 전진 시 last_inbox_check_at 은 건드리지 않음 — 폴백 하한으로서 여전히 안전한 값.
 */
async function pollViaHistory(ctx: UserCtx, startHistoryId: string): Promise<boolean> {
  const listedAt = Date.now()
  let hist: Awaited<ReturnType<typeof fetchHistoryEntries>>
  try {
    hist = await fetchHistoryEntries(ctx, startHistoryId)
  } catch (e) {
    if (e instanceof CallTimeoutError) {
      // 첫 페이지 타임아웃 — 폴백해도 같은 이유로 멈출 가능성이 큼. 커서 그대로 두고 다음 tick 재시도.
      console.warn('[check-inbox] history timeout uid=', ctx.userId, e.message)
      return true
    }
    // 404(historyId 만료) 또는 기타 오류 → 이번 tick 은 시간기반 폴백.
    console.warn(
      '[check-inbox] history fallback uid=',
      ctx.userId,
      e instanceof Error ? e.message : e,
    )
    if (e instanceof GmailHttpError && e.status === 404) {
      // 만료된 id 는 다시 써도 404 — 내려놓아 매 tick 헛호출 방지. 시간기반 드레인 완료 시 재시드됨.
      await updateProfile(ctx, { last_history_id: null })
    }
    return false
  }

  startProcessing(ctx)
  const outcomes = await processMessages(
    ctx,
    hist.entries.map((e) => e.id),
  )

  let firstUnhandledRec = -1
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i].handled) continue
    const rec = hist.entries[i].rec
    if (firstUnhandledRec < 0 || rec < firstUnhandledRec) firstUnhandledRec = rec
  }

  if (firstUnhandledRec < 0) {
    if (!hist.truncated) {
      await updateProfile(ctx, {
        last_history_id: hist.historyId,
        last_inbox_check_at: new Date(listedAt).toISOString(),
      })
    } else if (hist.records.length > 0) {
      await updateProfile(ctx, { last_history_id: hist.records[hist.records.length - 1] })
    }
  } else if (firstUnhandledRec > 0) {
    await updateProfile(ctx, { last_history_id: hist.records[firstUnhandledRec - 1] })
  }
  // firstUnhandledRec === 0 → 진전 없음 (첫 메시지가 일시 오류/예산 부족). 커서 유지, 다음 tick 재시도.
  return true
}

/**
 * 시간기반 경로 (첫 실행 / History 만료 폴백). 주의: Gmail `after:`/`before:` 는 **초 단위**.
 *
 *   1) 드레인 완료 시 History 경로로 넘어가기 위한 historyId 시드를 **목록 조회 전에** 받아 둠
 *      (조회 후에 받으면 그 사이 도착분이 History·시간기반 둘 다에서 빠짐).
 *   2) `after:<cursor>` 를 **한 페이지만** probe. 다 들어오면 그대로 처리 (보통 경우 호출 1회).
 *      잘리면 narrowWindow 가 before: 경계를 이분 탐색해 가장 오래된 구간의 **완전 목록** 확보.
 *      Gmail list 는 최신순이라 잘린 목록 = 창의 최신분 → 그걸로 커서를 넘기면 오래된 메일 영구 누락.
 *      완전 목록 창을 발견 예산 안에 못 찾으면 비어 있음을 확인한 앞 구간까지만 전진 (미조회 메일을
 *      절대 넘지 않음).
 *   3) 발견 종료 → startProcessing (최소 처리 시간 보장) → 오래된 순으로 처리 (사용자당 한도/예산까지).
 *   4) 커서:
 *      - 창 안 전부 처리: 좁힌 창이면 창 끝 직전, 아니면 조회 시각 - 겹침
 *      - 미처리 남음: 연속 처리된 구간의 가장 늦은 시각의 "초" 직전 (같은 초 메시지 재조회 → dedup)
 *      - 커서는 절대 후퇴하지 않음 (max(prev, next))
 */
async function pollViaTime(ctx: UserCtx, lastInboxCheckAt: string | null): Promise<void> {
  const listedAt = Date.now()
  const floorSecMs = (ms: number) => Math.floor(ms / 1000) * 1000
  const prevCursorMs = lastInboxCheckAt
    ? Date.parse(lastInboxCheckAt)
    : listedAt - INITIAL_LOOKBACK_HOURS * 3600_000
  const afterSec = Math.floor(prevCursorMs / 1000)

  let seedHistoryId: string | null = null
  try {
    seedHistoryId = await fetchCurrentHistoryId(ctx)
  } catch {
    /* 실패해도 다음 tick 에 재시도 */
  }

  // probe 실패 (타임아웃/HTTP 오류) 는 throw — 아직 아무것도 처리 안 했으므로 저장할 진행분 없음
  const probe = await fetchInboxMessageIds(ctx, afterSec, null, LIST_PAGE_SIZE)
  let listed: ListResult = probe
  let beforeSec: number | null = null
  let irreducible = false
  // [afterSec, emptyAfterSec] 는 비어 있음이 확인됨 (narrowWindow 가 하한을 끌어올린 지점)
  let emptyAfterSec = afterSec
  if (probe.truncated || probe.stoppedEarly) {
    const win = await narrowWindow(ctx, afterSec, Math.ceil(listedAt / 1000))
    if (!win.listed) {
      // 발견 예산 (시간/호출) 안에 완전 목록 창을 못 찾음 — 미조회 메일은 넘기지 않음.
      // 비어 있음을 확인한 앞 구간 [after, emptyAfterSec] 만큼만 전진 (없으면 커서 유지),
      // 다음 tick 이 거기서부터 재탐색 → 같은 탐색을 매 tick 반복하지 않음.
      console.warn(
        '[check-inbox] window narrowing incomplete uid=',
        ctx.userId,
        'after=',
        afterSec,
        'empty_until=',
        win.afterSec,
        'calls_left=',
        ctx.discoveryCallsLeft,
      )
      if (win.afterSec > afterSec) {
        await updateProfile(ctx, { last_inbox_check_at: new Date(win.afterSec * 1000).toISOString() })
      }
      return
    }
    listed = win.listed
    beforeSec = win.beforeSec
    irreducible = win.irreducible
    emptyAfterSec = win.afterSec
  }

  startProcessing(ctx)
  // Gmail list 는 최신순 → 뒤집어 오래된 순으로 처리
  const idsOldestFirst = listed.ids.slice().reverse()
  const outcomes = await processMessages(ctx, idsOldestFirst)

  const firstUnhandled = outcomes.findIndex((o) => !o.handled)
  // listed 는 항상 창의 완전 목록 (irreducible 예외 — narrowWindow 주석 참고)
  const drained = firstUnhandled < 0
  const prefixEnd = firstUnhandled < 0 ? outcomes.length : firstUnhandled
  let prefixMaxTs: number | null = null
  for (let i = 0; i < prefixEnd; i++) {
    const ts = outcomes[i].ts
    if (ts !== null && (prefixMaxTs === null || ts > prefixMaxTs)) prefixMaxTs = ts
  }

  const prevFloorMs = floorSecMs(prevCursorMs)
  let nextCursorMs: number
  if (drained && beforeSec !== null) {
    // 좁힌 창 [after, before) 를 다 비움 — 창 끝 직전부터 다음 구간 이어받음.
    // before ≥ after + MIN_WINDOW_SEC(2) 이므로 항상 최소 1초 전진.
    nextCursorMs = (beforeSec - 1) * 1000
  } else if (drained) {
    nextCursorMs = listedAt - CURSOR_OVERLAP_MS
  } else if (prefixMaxTs !== null && !irreducible) {
    nextCursorMs = floorSecMs(prefixMaxTs) - 1000
  } else {
    // 처리 진전 없음 — 비어 있음을 확인한 구간까지만 전진 (없으면 같은 지점부터 재시도)
    nextCursorMs = emptyAfterSec * 1000
  }
  nextCursorMs = Math.max(prevFloorMs, nextCursorMs)

  const upd: ProfileUpdate = { last_inbox_check_at: new Date(nextCursorMs).toISOString() }
  // 백로그를 전부 비웠을 때만 History 경로로 전환 (아직 남았는데 전환하면 backlog skip 위험).
  if (drained && beforeSec === null && seedHistoryId) {
    upd.last_history_id = seedHistoryId
  }
  await updateProfile(ctx, upd)
}

/**
 * 시간 창 경계 탐색 — probe `[after, now)` 가 한 페이지를 넘을 때.
 * `[after, b)` 가 한 페이지 (LIST_PAGE_SIZE) 에 다 들어오는 b 를 찾음 (호출 1회/단계).
 *   1) 갤럽: b = after + 60초 × 16^k 로 키우다 처음 잘리는 지점을 hi 로 (끝은 endSec = 조회 시각).
 *      위에서부터 반씩 좁히면 오래된 커서 (예: 30일) 직후에 몰린 메일까지 매 tick ~21회 호출이
 *      필요해 발견 예산을 넘고, 다음 tick 도 같은 탐색을 반복하는 livelock 이 됨. 백로그 드레인 중
 *      다음 미처리 메일은 커서 바로 뒤라 갤럽은 보통 몇 회로 끝남.
 *   2) 이분: [lo, hi) 사이를 반씩 좁힘.
 *   불변식: [after, lo) 는 완전 목록 (lo === after 면 빈 창), [after, hi) 는 잘림 (hi=null 이면 미발견).
 *   NARROW_ENOUGH_IDS 이상 들어오는 완전 목록 창을 찾으면 조기 종료 (한 tick 처리량으로 충분).
 *   시간/호출 예산이 끊겨도 그때까지 찾은 완전 목록 창 [after, lo) 를 쓰므로 진전이 남음.
 * 반환:
 *   - { listed, afterSec, beforeSec } — listed 는 [afterSec, beforeSec) 의 **완전** 목록 (가장 오래된
 *     메일 포함). afterSec ≥ startSec 이며 [startSec, afterSec] 는 비어 있음이 확인된 구간.
 *   - lo 가 최소 창에도 못 미치면 [after, hi) 를 끝까지 페이지 (LIST_ID_CAP 까지) 해서 가장 오래된 id 확보
 *   - irreducible=true — MIN_WINDOW_SEC (2초) 창에 LIST_ID_CAP 통 초과. Gmail 검색은 초 단위라 더
 *     쪼갤 수 없음 (대량 import 외 발생 불가). 수집분 처리 후 그 2초를 넘김 — 커서가 영구히 묶여
 *     이후 모든 메일이 막히는 것보다 나음. console.error 로 남김.
 *   - listed=null — 발견 예산 안에 완전 목록 창을 못 찾음 → 호출자는 afterSec (빈 구간 끝) 까지만 전진
 */
async function narrowWindow(
  ctx: UserCtx,
  startSec: number,
  endSec: number,
): Promise<{ listed: ListResult | null; afterSec: number; beforeSec: number; irreducible: boolean }> {
  // 탐색 하한 — [startSec, mid) 가 비어 있으면 mid - 1 로 끌어올림 (1초 겹침 유지).
  // 잘린 창의 내용은 그대로라 불변식 유지, 이후 단계는 더 좁은 구간만 봄.
  let afterSec = startSec
  let lo = afterSec
  let loIds: string[] = []
  let hi: number | null = null
  let width = GALLOP_START_SEC
  for (let step = 0; step < MAX_WINDOW_NARROW_STEPS && canDiscover(ctx); step++) {
    let mid: number
    if (hi === null) {
      // 갤럽 — 커서에서부터 창을 키움
      mid = Math.min(endSec, afterSec + Math.max(MIN_WINDOW_SEC, width))
      width *= GALLOP_FACTOR
      if (mid <= lo) break
    } else {
      // 이분 — [lo, hi) 사이
      if (hi - lo <= 1) break
      mid = Math.max(afterSec + MIN_WINDOW_SEC, Math.floor((lo + hi) / 2))
      if (mid >= hi) break
    }
    let r: ListResult
    try {
      r = await fetchInboxMessageIds(ctx, afterSec, mid, LIST_PAGE_SIZE)
    } catch (e) {
      // 탐색 중 타임아웃/오류 — 지금까지 찾은 완전 목록 창으로 진행
      console.warn(
        '[check-inbox] narrow list fail uid=',
        ctx.userId,
        e instanceof Error ? e.message : e,
      )
      break
    }
    if (r.stoppedEarly) break
    if (r.truncated) {
      hi = mid
    } else if (r.ids.length === 0 && mid < endSec) {
      // 빈 구간 — 하한을 끌어올리고 계속 (커서 바로 뒤에 메일이 몰린 경우 같은 tick 안에 도달)
      afterSec = mid - 1
      lo = afterSec
      loIds = []
    } else {
      lo = mid
      loIds = r.ids
      // 조회 시각까지 완전 목록 (probe 를 넘친 건 그 이후 도착분뿐) 이면 더 볼 것 없음
      if (r.ids.length >= NARROW_ENOUGH_IDS || mid >= endSec) break
    }
  }
  const hiSec = hi ?? endSec
  const none = { listed: null, afterSec, beforeSec: hiSec, irreducible: false }
  if (lo >= afterSec + MIN_WINDOW_SEC) {
    return {
      listed: { ids: loIds, truncated: false, stoppedEarly: false },
      afterSec,
      beforeSec: lo,
      irreducible: false,
    }
  }

  // 가장 오래된 최소 구간도 한 페이지 초과 — 그 창을 끝까지 페이지해서 가장 오래된 id 까지 수집
  let paged: ListResult
  try {
    paged = await fetchInboxMessageIds(ctx, afterSec, hiSec, LIST_ID_CAP)
  } catch (e) {
    console.warn(
      '[check-inbox] window page fail uid=',
      ctx.userId,
      e instanceof Error ? e.message : e,
    )
    return none
  }
  if (paged.stoppedEarly) return none
  if (!paged.truncated) return { listed: paged, afterSec, beforeSec: hiSec, irreducible: false }
  if (hiSec - afterSec <= MIN_WINDOW_SEC) {
    console.error(
      '[check-inbox] >',
      LIST_ID_CAP,
      'inbox messages within',
      MIN_WINDOW_SEC,
      's — skipping unlisted remainder uid=',
      ctx.userId,
      'after=',
      afterSec,
    )
    return { listed: paged, afterSec, beforeSec: hiSec, irreducible: true }
  }
  return none
}

// 발견 단계 호출 가능 여부 — 호출 수 / 발견 마감 (호출 1건 최소 타임아웃만큼 여유) 상한
function canDiscover(ctx: UserCtx): boolean {
  return ctx.discoveryCallsLeft > 0 && Date.now() < ctx.discoveryDeadline - MIN_CALL_TIMEOUT_MS
}

// 발견 종료 → 처리 마감 확정. 발견이 슬라이스를 다 썼어도 최소 MIN_PROCESS_MS 는 처리 (run 예산 이내).
function startProcessing(ctx: UserCtx): void {
  ctx.deadline = Math.min(ctx.runDeadline, Math.max(ctx.sliceDeadline, Date.now() + MIN_PROCESS_MS))
}

// 백로그 사용자 — 시간기반 경로이면서 커서가 BACKLOG_THRESHOLD_MS 이상 과거.
// (첫 실행 NULL 은 24시간 lookback 한정이라 일반 취급)
function isBacklogged(p: ProfileRow, nowMs: number): boolean {
  if (p.last_history_id || !p.last_inbox_check_at) return false
  const cursorMs = Date.parse(p.last_inbox_check_at)
  return Number.isFinite(cursorMs) && nowMs - cursorMs > BACKLOG_THRESHOLD_MS
}

/**
 * ids (오래된 순) 를 처리. 반환 outcomes[i] 는 ids[i] 에 대응.
 *   1) 청크별로 이미 기록된 gmail_message_id 를 1회 조회해 건너뜀 (received_at 을 커서용 ts 로 사용)
 *   2) 미기록분 중 앞에서부터 PER_USER_MAX_MESSAGES 통만 fetch + 기록 (FETCH_CONCURRENCY 병렬)
 *   3) 마감(ctx.deadline) 이 다가오면 중단 — 나머지는 handled=false 로 남아 다음 tick 이월
 */
async function processMessages(ctx: UserCtx, ids: string[]): Promise<MsgOutcome[]> {
  const outcomes: MsgOutcome[] = ids.map(() => ({ handled: false, ts: null }))
  const work: number[] = []

  scan: for (let start = 0; start < ids.length; start += DEDUP_CHUNK) {
    if (Date.now() > ctx.deadline - MESSAGE_FETCH_BUDGET_MS) break
    const chunk = ids.slice(start, start + DEDUP_CHUNK)
    const { data, error } = await ctx.supabase
      .schema('mailcaster')
      .from('inbound_messages')
      .select('gmail_message_id, received_at')
      .eq('org_id', ctx.orgId)
      .in('gmail_message_id', chunk)
    if (error) {
      // 조회 실패 — 이번 tick 은 여기까지 (커서는 처리분까지만 전진하므로 안전)
      console.warn('[check-inbox] dedup query fail uid=', ctx.userId, error.message)
      break
    }
    const existing = new Map<string, number>()
    for (const row of (data ?? []) as Array<{ gmail_message_id: string; received_at: string }>) {
      existing.set(row.gmail_message_id, Date.parse(row.received_at))
    }
    for (let j = 0; j < chunk.length; j++) {
      const seenTs = existing.get(chunk[j])
      if (seenTs !== undefined) {
        outcomes[start + j] = { handled: true, ts: Number.isFinite(seenTs) ? seenTs : null }
        ctx.stats.skippedExisting++
        continue
      }
      if (work.length >= PER_USER_MAX_MESSAGES) break scan
      work.push(start + j)
    }
  }

  let recordOk = 0
  for (let b = 0; b < work.length; b += FETCH_CONCURRENCY) {
    if (Date.now() > ctx.deadline - MESSAGE_FETCH_BUDGET_MS) break
    const batch = work.slice(b, b + FETCH_CONCURRENCY)
    const results = await Promise.all(batch.map((i) => processOne(ctx, ids[i])))
    batch.forEach((i, k) => {
      outcomes[i] = results[k]
      if (results[k].recordOk) recordOk++
    })
  }

  // 독(poison) 메시지 포기 — 같은 tick 에 다른 기록은 성공했는데(시스템 장애 아님) 이 메시지만
  // 계속 실패하고 수신 후 RECORD_GIVEUP_AGE_MS 가 지났으면 넘어감. 커서가 영구히 묶이는 것 방지.
  if (recordOk > 0) {
    const now = Date.now()
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i]
      if (o.recordFailed && !o.handled && o.ts !== null && now - o.ts > RECORD_GIVEUP_AGE_MS) {
        console.error('[check-inbox] giving up on message uid=', ctx.userId, 'mid=', ids[i])
        outcomes[i] = { ...o, handled: true }
      }
    }
  }
  return outcomes
}

/** 메시지 1통 fetch + 기록. throw 하지 않음 — 결과는 MsgOutcome 으로. */
async function processOne(ctx: UserCtx, msgId: string): Promise<MsgOutcome> {
  let meta: GmailMessage | null
  try {
    try {
      meta = await fetchMessageMeta(ctx, msgId)
    } catch (e0) {
      // 처리 마감(슬라이스)이 짧아 시간 초과됐을 수 있음 — run 마감 한도 안에서 1회 재시도.
      // 재시도 없이 두면 매 run 같은 메일에서 시간 초과 → 커서가 그 앞에 영구 고정된다.
      if (!(e0 instanceof CallTimeoutError)) throw e0
      const retryDeadline = Math.min(ctx.runDeadline, Date.now() + CALL_TIMEOUT_MS)
      if (retryDeadline - Date.now() < MIN_CALL_TIMEOUT_MS) throw e0
      meta = await fetchMessageMeta(ctx, msgId, retryDeadline)
    }
  } catch (e) {
    ctx.stats.gmailErrors++
    // 400 = 잘못된 id 등 재시도해도 같은 결과 → skip. 그 외(401/403 rate limit/429/5xx/네트워크)는 재시도.
    const permanent = e instanceof GmailHttpError && e.status === 400
    console.warn(
      '[check-inbox] msg fail uid=',
      ctx.userId,
      'mid=',
      msgId,
      e instanceof Error ? e.message : e,
    )
    return { handled: permanent, ts: null }
  }
  if (!meta) return { handled: true, ts: null } // 404 — 그 사이 삭제됨

  const ts = Number(meta.internalDate ?? 0)
  if (!ts) return { handled: true, ts: null }

  try {
    // 본인이 보낸 메일 (Sent label 또는 from=self) — 폴링 대상 아님 (이미 thread_messages 처리)
    const labels = meta.labelIds ?? []
    if (labels.includes('SENT')) return { handled: true, ts }

    const headers = meta.payload?.headers
    const fromRaw = getHeader(headers, 'From')
    if (!fromRaw) return { handled: true, ts }
    const fromParsed = parseFromAddress(fromRaw)
    if (!fromParsed.email) return { handled: true, ts }
    if (fromParsed.email === ctx.userEmailLower) return { handled: true, ts } // 자기 자신
    // Google Groups(sales@ 같은 팀 공용 주소)는 발신 도메인 DMARC 가 엄격하면 From 을 그룹
    // 주소로 바꿔 보낸다 — 그대로 쓰면 고객 대신 우리 그룹 주소가 연락처로 생긴다.
    // 실제 발신자는 X-Original-Sender(없으면 Reply-To). 둘 다 없으면 연락처 자동 생성 안 함.
    const groupAddr = groupAddressOf(headers)
    let groupRewriteUnresolved = false
    if (groupAddr && fromParsed.email === groupAddr) {
      const orig = parseFromAddress(getHeader(headers, 'X-Original-Sender') ?? '').email ??
        parseEmailList(getHeader(headers, 'Reply-To') ?? '')[0] ?? null
      if (orig && orig !== groupAddr && orig !== ctx.userEmailLower) {
        fromParsed.email = orig
      } else {
        groupRewriteUnresolved = true
      }
    }

    // 본문 + 메타
    const subject = getHeader(headers, 'Subject')
    const rfcMessageId = getHeader(headers, 'Message-ID') ?? getHeader(headers, 'Message-Id')
    const toHeader = getHeader(headers, 'To') ?? ''
    const ccHeader = getHeader(headers, 'Cc') ?? ''
    const toEmails = parseEmailList(toHeader).concat(parseEmailList(ccHeader))
    const bodyText = stripQuoteOnly(extractTextBody(meta.payload) ?? '').slice(0, 8000)
    const bodyHtml = capBodyHtml(extractHtmlBody(meta.payload))
    const automated = isAutomatedMessage(labels, fromParsed.email, headers)

    ctx.stats.processed++

    const { data: rpcData, error: rpcErr } = await ctx.supabase
      .schema('mailcaster')
      .rpc('record_inbound_message', {
        p_org_id: ctx.orgId,
        p_user_id: ctx.userId,
        p_gmail_message_id: meta.id,
        p_gmail_thread_id: meta.threadId,
        p_rfc_message_id: rfcMessageId,
        p_from_email: fromParsed.email,
        p_from_name: fromParsed.name,
        p_to_emails: toEmails,
        p_subject: subject,
        p_snippet: meta.snippet ?? null,
        p_body_text: bodyText,
        p_body_html: bodyHtml,
        p_received_at: new Date(ts).toISOString(),
        // 자동 발송/대량 메일은 기존 contact 매칭만 — 새 contact 는 만들지 않음
        p_auto_create_contact: !automated && !groupRewriteUnresolved,
      })
    if (rpcErr) {
      ctx.stats.recordErrors++
      console.warn(
        '[check-inbox] record rpc fail uid=',
        ctx.userId,
        'mid=',
        meta.id,
        rpcErr.message,
      )
      return { handled: false, ts, recordFailed: true }
    }
    // rpcData 는 array (TABLE returning) — 첫 row
    const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { inserted?: boolean; contact_id?: string | null; contact_created?: boolean }
      | null
      | undefined
    if (result?.inserted) ctx.stats.recorded++
    if (result?.contact_created) ctx.stats.contactsCreated++
    if (automated && result?.inserted && !result?.contact_id) ctx.stats.contactsSuppressed++

    // Tier1-C — 시퀀스 자동 정지: contact 가 새로 회신/연락해오면(새 inbound)
    // 진행 중 시퀀스를 중단해 사람이 인계하게 한다. (idempotent — active 만 영향)
    if (result?.inserted && result?.contact_id) {
      const { error: stopErr } = await ctx.supabase
        .schema('mailcaster')
        .rpc('stop_active_enrollments_for_contact', {
          p_org_id: ctx.orgId,
          p_contact_id: result.contact_id,
          p_reason: 'replied',
        })
      if (stopErr) {
        console.warn('[check-inbox] seq stop fail', result.contact_id, stopErr.message)
      }
    }
    return { handled: true, ts, recordOk: true }
  } catch (e) {
    ctx.stats.recordErrors++
    console.warn(
      '[check-inbox] msg process fail uid=',
      ctx.userId,
      'mid=',
      msgId,
      e instanceof Error ? e.message : e,
    )
    return { handled: false, ts, recordFailed: true }
  }
}

async function updateProfile(ctx: UserCtx, upd: ProfileUpdate): Promise<void> {
  const { error } = await ctx.supabase
    .schema('mailcaster')
    .from('profiles')
    .update(upd)
    .eq('id', ctx.userId)
  if (error) console.warn('[check-inbox] cursor save fail uid=', ctx.userId, error.message)
}

// 자동 발송/대량 메일 여부 — true 면 contact 자동 생성 안 함 (inbound 기록은 그대로).
//
// 강한 신호 (단독으로 자동 메일):
//   - noreply / mailer-daemon / notifications 류 발신 주소
//   - Auto-Submitted ≠ no (RFC 3834 — 자동 생성·부재중 회신)
//   - Precedence: bulk / junk
//   - Gmail CATEGORY_PROMOTIONS / CATEGORY_SOCIAL
// 약한 신호 (서로 다른 종류 2개 이상일 때만 자동 메일):
//   - 메일링리스트: List-Id / List-Unsubscribe / Precedence: list / CATEGORY_FORUMS
//     → Google Groups·공동 받은편지함 (sales@, contact@, info@) 이 실제 고객 메일에 **함께** 붙이는
//       헤더라 묶어서 1종으로 셈. 따로 세면 그룹 별칭으로 들어온 모든 리드가 자동 메일로 분류됨.
//       영업 툴 (수신거부 링크 포함) 로 보낸 실제 사람 메일도 이 1종만 해당.
//   - CATEGORY_UPDATES (머신러닝 분류 — 사람 메일·캘린더 초대에도 자주 붙음)
//   - Feedback-ID (Gmail 대량 발송자 요구 헤더 — ESP 발송)
// 오탐 (뉴스레터가 contact 생성) 보다 미탐 (실제 리드 contact 누락) 이 더 비싸므로 보수적으로 판정.
function isAutomatedMessage(
  labels: string[],
  fromEmail: string,
  headers: Array<{ name: string; value: string }> | undefined,
): boolean {
  // --- 강한 신호
  const localPart = fromEmail.split('@')[0] ?? ''
  if (AUTOMATED_LOCAL_PART_RE.test(localPart)) return true
  const autoSubmitted = (getHeader(headers, 'Auto-Submitted') ?? '').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return true
  const precedence = (getHeader(headers, 'Precedence') ?? '').trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'junk') return true
  if (labels.some((l) => STRONG_AUTOMATED_CATEGORY_LABELS.includes(l))) return true

  // --- 약한 신호 (종류별 1개씩만 셈)
  const listSignal = !!getHeader(headers, 'List-Id') ||
    !!getHeader(headers, 'List-Unsubscribe') ||
    precedence === 'list' ||
    labels.includes('CATEGORY_FORUMS')
  const updatesSignal = labels.includes('CATEGORY_UPDATES')
  // Feedback-ID(Postmaster 피드백 루프) 또는 RFC 8058 원클릭 수신거부(List-Unsubscribe-Post —
  // Gmail 이 대량 발신자에게 요구하는 헤더). Google Groups 메일은 원클릭 헤더가 붙어도 고객 메일이라 제외.
  const isGoogleGroup = !!getHeader(headers, 'X-Google-Group-Id')
  const bulkSenderSignal = !!getHeader(headers, 'Feedback-ID') ||
    (!isGoogleGroup && /one-click/i.test(getHeader(headers, 'List-Unsubscribe-Post') ?? ''))
  const weak = Number(listSignal) + Number(updatesSignal) + Number(bulkSenderSignal)
  return weak >= 2
}

// 메일링 리스트(그룹)의 자체 주소 — List-Post 의 mailto: 우선, 없으면 List-Id <local.domain> 형태에서 추정.
function groupAddressOf(headers: Array<{ name: string; value: string }> | undefined): string | null {
  const post = getHeader(headers, 'List-Post') ?? ''
  const m = post.match(/mailto:([^>\s?]+)/i)
  if (m) return m[1].trim().toLowerCase()
  if (!getHeader(headers, 'X-Google-Group-Id')) return null
  const id = (getHeader(headers, 'List-Id') ?? '').match(/<([^>]+)>/)?.[1] ?? ''
  const dot = id.indexOf('.')
  return dot > 0 ? `${id.slice(0, dot)}@${id.slice(dot + 1)}`.toLowerCase() : null
}

// body_html 저장 상한 — 초과 시 NULL (잘라 저장하면 깨진 HTML 이 됨. body_text 는 별도 보존)
function capBodyHtml(html: string | null): string | null {
  if (!html) return null
  if (html.length > BODY_HTML_MAX_BYTES) return null
  return new TextEncoder().encode(html).byteLength > BODY_HTML_MAX_BYTES ? null : html
}

// ============================================================
// Gmail 헬퍼
// ============================================================

/**
 * Gmail / OAuth 호출 공통 타임아웃 래퍼.
 *   timeout = min(CALL_TIMEOUT_MS, deadline - now) (하한 MIN_CALL_TIMEOUT_MS).
 *   응답 본문까지 타이머 안에서 다 읽음 — 헤더만 오고 본문이 멈추는 경우도 끊김.
 *   시간 초과 시 CallTimeoutError (호출자는 일시 오류로 처리하고 진행분 커서는 그대로 저장).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  deadline: number,
  label: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const timeoutMs = Math.max(
    MIN_CALL_TIMEOUT_MS,
    Math.min(CALL_TIMEOUT_MS, deadline - Date.now()),
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (e) {
    if (controller.signal.aborted) {
      throw new CallTimeoutError(`${label} timeout (${timeoutMs}ms)`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function gmailGet(ctx: UserCtx, url: string, deadline: number, label: string) {
  return fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
    deadline,
    label,
  )
}

// 발견 단계 Gmail 호출 — 호출 수 차감 + 발견 마감으로 타임아웃 제한
function discoveryGet(ctx: UserCtx, url: string, label: string) {
  ctx.discoveryCallsLeft--
  return gmailGet(ctx, url, ctx.discoveryDeadline, label)
}

interface ListResult {
  ids: string[]
  // maxIds 에 도달했는데 다음 페이지가 남음 (수집분 = 창의 최신분, 더 오래된 메일이 밖에 존재)
  truncated: boolean
  // 발견 예산 (시간/호출) 소진으로 페이지를 다 못 돎 — truncated 와 마찬가지로 불완전 목록
  stoppedEarly: boolean
}

/**
 * `in:inbox after:<afterSec> [before:<beforeSec>]` 의 message id (최신순) 를 nextPageToken 으로 수집.
 * maxIds 에 도달했는데 다음 페이지가 남아 있으면 truncated=true.
 * 페이지마다 발견 예산 확인 — 소진되면 stoppedEarly=true 로 수집분 반환. 호출 실패는 throw.
 */
async function fetchInboxMessageIds(
  ctx: UserCtx,
  afterSec: number,
  beforeSec: number | null,
  maxIds: number,
): Promise<ListResult> {
  const q = beforeSec !== null
    ? `in:inbox after:${afterSec} before:${beforeSec}`
    : `in:inbox after:${afterSec}`
  const ids: string[] = []
  let pageToken: string | undefined
  for (;;) {
    if (!canDiscover(ctx)) return { ids, truncated: false, stoppedEarly: true }
    const params = new URLSearchParams({ q, maxResults: String(LIST_PAGE_SIZE) })
    if (pageToken) params.set('pageToken', pageToken)
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`
    const res = await discoveryGet(ctx, url, 'Gmail list')
    if (!res.ok) {
      throw new GmailHttpError(`Gmail list ${res.status}: ${res.text.slice(0, 200)}`, res.status)
    }
    const data = JSON.parse(res.text) as {
      messages?: Array<{ id: string }>
      nextPageToken?: string
    }
    for (const m of data.messages ?? []) ids.push(m.id)
    if (!data.nextPageToken) return { ids, truncated: false, stoppedEarly: false }
    if (ids.length >= maxIds) return { ids, truncated: true, stoppedEarly: false }
    pageToken = data.nextPageToken
  }
}

/**
 * History API: startHistoryId 이후 INBOX 에 추가된(messageAdded) 메시지 id 델타 (오래된 순).
 *   - entries: 메시지 id + 처음 등장한 history record 의 인덱스 (dedup)
 *   - records: 수집한 history record id (오래된 순) — 부분 처리 시 커서 전진 지점
 *   - historyId: 응답의 mailbox historyId (truncated=false 일 때만 커서로 사용 가능)
 *   - truncated: 페이지/개수/발견 예산 상한, 또는 2페이지 이후 호출 실패로 뒤 record 를 다 못 모음
 * 첫 페이지 실패는 throw — 404(만료)·기타 → 호출자가 시간기반 폴백, 타임아웃 → 이번 tick skip.
 */
async function fetchHistoryEntries(
  ctx: UserCtx,
  startHistoryId: string,
): Promise<{
  entries: Array<{ id: string; rec: number }>
  records: string[]
  historyId: string
  truncated: boolean
}> {
  const entries: Array<{ id: string; rec: number }> = []
  const records: string[] = []
  const seen = new Set<string>()
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    if (!canDiscover(ctx)) break
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
      maxResults: '500',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`
    let res: Awaited<ReturnType<typeof discoveryGet>>
    try {
      res = await discoveryGet(ctx, url, 'Gmail history')
      if (!res.ok) {
        // 404 = startHistoryId 만료(가지치기됨). 호출자가 시간기반으로 폴백.
        throw new GmailHttpError(
          `Gmail history ${res.status}: ${res.text.slice(0, 150)}`,
          res.status,
        )
      }
    } catch (e) {
      if (page === 0) throw e
      // 뒤 페이지 실패 — 수집한 앞 record 까지만 처리 (truncated → 마지막 처리 record 로 전진)
      console.warn(
        '[check-inbox] history page fail uid=',
        ctx.userId,
        e instanceof Error ? e.message : e,
      )
      break
    }
    const data = JSON.parse(res.text) as {
      history?: Array<{ id: string; messagesAdded?: Array<{ message?: { id?: string } }> }>
      historyId?: string
      nextPageToken?: string
    }
    if (data.historyId) latestHistoryId = data.historyId
    for (const h of data.history ?? []) {
      const rec = records.length
      records.push(h.id)
      for (const ma of h.messagesAdded ?? []) {
        const id = ma.message?.id
        if (id && !seen.has(id)) {
          seen.add(id)
          entries.push({ id, rec })
        }
      }
    }
    if (!data.nextPageToken) {
      return { entries, records, historyId: latestHistoryId, truncated: false }
    }
    if (entries.length >= LIST_ID_CAP) break
    pageToken = data.nextPageToken
  }
  return { entries, records, historyId: latestHistoryId, truncated: true }
}

// 현재 mailbox 의 historyId — 시간기반 폴백 후 History 경로로 전환하기 위한 시드.
async function fetchCurrentHistoryId(ctx: UserCtx): Promise<string> {
  if (!canDiscover(ctx)) throw new CallTimeoutError('discovery budget exhausted')
  const res = await discoveryGet(
    ctx,
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    'Gmail getProfile',
  )
  if (!res.ok) throw new GmailHttpError(`Gmail getProfile ${res.status}`, res.status)
  const data = JSON.parse(res.text) as { historyId?: string }
  if (!data.historyId) throw new Error('no historyId in profile')
  return data.historyId
}

async function fetchMessageMeta(
  ctx: UserCtx,
  messageId: string,
  deadline: number = ctx.deadline,
): Promise<GmailMessage | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  // 처리 마감으로 타임아웃 제한 — 멈춘 호출이 슬라이스·run 예산을 넘기지 않게
  const res = await gmailGet(ctx, url, deadline, 'Gmail get')
  if (!res.ok) {
    if (res.status === 404) return null
    throw new GmailHttpError(`Gmail get ${res.status}`, res.status)
  }
  return JSON.parse(res.text) as GmailMessage
}

function getHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

// "Name <foo@bar.com>" / "foo@bar.com" 파싱
function parseFromAddress(raw: string): { email: string | null; name: string | null } {
  const m = raw.match(/^\s*(?:"?([^"<]+?)"?\s*)?<\s*([^>\s]+)\s*>\s*$/)
  if (m) return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() }
  const trimmed = raw.trim()
  if (/^[^\s@]+@[^\s@]+$/.test(trimmed)) return { email: trimmed.toLowerCase(), name: null }
  return { email: null, name: raw.slice(0, 200) }
}

// To/CC 헤더의 콤마 구분 이메일 리스트 추출
function parseEmailList(header: string): string[] {
  if (!header) return []
  const out: string[] = []
  // 단순 정규식 — `"a, b" <x@y>` 같은 코너 케이스는 무시 (모니터링 목적이라 충분)
  for (const part of header.split(',')) {
    const angle = /<([^>]+)>/.exec(part)
    const cand = angle?.[1] ?? part.trim()
    if (/^[^\s@]+@[^\s@]+$/.test(cand)) out.push(cand.toLowerCase())
  }
  return out
}

// 본문 추출 (text/plain 우선)
function extractTextBody(part?: GmailPart): string | null {
  if (!part) return null
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data)
  }
  if (part.parts && part.parts.length > 0) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data)
    }
    for (const p of part.parts) {
      const nested = extractTextBody(p)
      if (nested) return nested
    }
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data))
  }
  return null
}

// 본문 추출 (text/html — display 용, 저장 시 sanitize 안 함 — UI 에서 처리)
function extractHtmlBody(part?: GmailPart): string | null {
  if (!part) return null
  if (part.mimeType === 'text/html' && part.body?.data) {
    return decodeBase64Url(part.body.data)
  }
  if (part.parts && part.parts.length > 0) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) return decodeBase64Url(p.body.data)
    }
    for (const p of part.parts) {
      const nested = extractHtmlBody(p)
      if (nested) return nested
    }
  }
  return null
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// 인용 (>로 시작 라인, "On ... wrote:" 헤더) 제거. 시그니처는 보존.
function stripQuoteOnly(text: string): string {
  const patterns = [
    /\n\s*On .+ wrote:[\s\S]*$/m,
    /\n\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[\s\S]+(작성|wrote|쓴 글|보낸 메일):[\s\S]*$/m,
    /\n\s*-+\s*Original Message\s*-+[\s\S]*$/im,
    /\n\s*From:.+\nSent:.+[\s\S]*$/im,
  ]
  let out = text
  for (const re of patterns) out = out.replace(re, '')
  out = out
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
  return out.trim()
}

async function refreshGoogleToken(storedToken: string, deadline: number): Promise<string> {
  const refreshToken = await decryptToken(storedToken)
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetchWithTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    deadline,
    'token refresh',
  )
  if (!res.ok) {
    throw new Error(`token refresh ${res.status}: ${res.text.slice(0, 200)}`)
  }
  const data = JSON.parse(res.text) as { access_token?: string }
  if (!data.access_token) throw new Error('no access_token in refresh response')
  return data.access_token
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
