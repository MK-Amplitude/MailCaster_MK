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
//     단 자동 발송/대량 메일 (Gmail 프로모션·소셜·업데이트·포럼 카테고리, noreply 류 주소,
//     List-Unsubscribe / List-Id / Precedence: bulk 헤더) 은 inbound 로만 기록하고
//     contact 는 만들지 않음 (isAutomatedMessage). 뉴스레터마다 contacts·audit 행이 쌓이던 문제.
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
//   - 사용자별 시간 슬라이스 (남은 예산 / 남은 사용자) — 백로그 큰 사용자 한 명이 tick 전체를
//     점유해 다른 사용자가 굶던 livelock 방지. 예산이 끊겨도 그 사용자 진행분은 항상 저장.
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
// 사용자 1명을 시작하려면 필요한 최소 잔여 예산 (토큰 갱신 + 목록 조회 + 커서 저장)
const USER_MIN_BUDGET_MS = 4_000
// 사용자별 시간 슬라이스 하한
const MIN_USER_SLICE_MS = 6_000
// 메시지 fetch + 기록 동시 실행 수 (Gmail 사용자별 rate limit 과 nano DB 를 고려해 보수적으로)
const FETCH_CONCURRENCY = 4
// 목록(id) 수집 상한 / 페이지 크기 — id 목록은 가벼워 넉넉히 모은 뒤 오래된 순으로 처리
const LIST_ID_CAP = 2_000
const LIST_PAGE_SIZE = 500
// 시간기반 목록이 LIST_ID_CAP 를 넘으면 before: 로 창을 반씩 좁혀 가장 오래된 구간부터 드레인
const MAX_WINDOW_NARROW_STEPS = 12
const MIN_WINDOW_SEC = 60
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

// 자동 발송/대량 메일 판정 — contact 자동 생성 제외용
const AUTOMATED_CATEGORY_LABELS = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]
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
  // 이 사용자 처리 마감 시각 (epoch ms) — 시간 슬라이스와 run 예산 중 이른 쪽
  deadline: number
  stats: RunStats
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
    //    시간기반 백로그 사용자는 커서(=메시지 시각)가 과거라 항상 앞에 오지만, 사용자별
    //    시간 슬라이스 + 메시지 한도 때문에 tick 을 독점하지 못하고 뒤 사용자도 매 tick 처리됨.
    const { data: profiles, error: pErr } = await supabase
      .schema('mailcaster')
      .from('profiles')
      .select('id, email, google_refresh_token, last_inbox_check_at, last_history_id, default_org_id')
      .not('google_refresh_token', 'is', null)
      .order('last_inbox_check_at', { ascending: true, nullsFirst: true })

    if (pErr) throw pErr
    const candidates = (profiles ?? []) as Array<{
      id: string
      email: string
      google_refresh_token: string
      last_inbox_check_at: string | null
      last_history_id: string | null
      default_org_id: string | null
    }>

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

    for (let idx = 0; idx < candidates.length; idx++) {
      const profile = candidates[idx]
      const remainingMs = runDeadline - Date.now()
      if (remainingMs < USER_MIN_BUDGET_MS) break

      // org_id 결정 — profile 의 default_org 또는 첫 org 멤버십.
      // default 가 NULL 이면 stub (skip — 이런 사용자는 org 미설정 상태)
      const orgId = profile.default_org_id
      if (!orgId) continue

      // 공정 분배 — 남은 예산을 남은 사용자 수로 나눈 만큼만 (하한 MIN_USER_SLICE_MS).
      // 일찍 끝난 사용자의 잔여 시간은 다음 사용자 몫 계산에 자연히 반영됨.
      const sliceMs = Math.max(
        MIN_USER_SLICE_MS,
        Math.floor(remainingMs / (candidates.length - idx)),
      )

      let accessToken: string
      try {
        accessToken = await refreshGoogleToken(profile.google_refresh_token)
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
        deadline: Math.min(runDeadline, Date.now() + sliceMs),
        stats,
      }

      // 2) 메시지 발견: History API 우선(델타), 실패/미보유 시 시간기반 폴백.
      //    두 경로 모두 처리 후 반드시 커서를 저장 (예산 소진 시에도 진행분 보존).
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
 *   - 전부 처리 + 목록이 잘림(페이지/개수 상한) → 수집한 마지막 record id 로 전진
 *   - 미처리 남음 → "미처리 메시지가 처음 등장한 record" 바로 앞 record id 까지만 전진
 *     (이미 처리한 뒤쪽 메시지는 다음 tick 에 dedup 으로 비용 없이 걸러짐)
 *   부분 전진 시 last_inbox_check_at 은 건드리지 않음 — 폴백 하한으로서 여전히 안전한 값.
 */
async function pollViaHistory(ctx: UserCtx, startHistoryId: string): Promise<boolean> {
  const listedAt = Date.now()
  let hist: Awaited<ReturnType<typeof fetchHistoryEntries>>
  try {
    hist = await fetchHistoryEntries(ctx.accessToken, startHistoryId)
  } catch (e) {
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
 *   2) `after:<cursor>` id 를 페이지 끝까지 수집. LIST_ID_CAP 초과면 before: 로 창을 반씩 좁혀
 *      가장 오래된 구간이 한 페이지에 다 들어오게 함 → 오래된 메일을 건너뛰지 않음.
 *   3) 오래된 순으로 처리 (사용자당 한도/예산까지).
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
    seedHistoryId = await fetchCurrentHistoryId(ctx.accessToken)
  } catch {
    /* 실패해도 다음 tick 에 재시도 */
  }

  let beforeSec: number | null = null
  let listed = await fetchInboxMessageIds(ctx.accessToken, afterSec, null, LIST_ID_CAP)
  for (let step = 0; listed.truncated && step < MAX_WINDOW_NARROW_STEPS; step++) {
    const endSec: number = beforeSec ?? Math.ceil(listedAt / 1000)
    const spanSec = endSec - afterSec
    if (spanSec <= MIN_WINDOW_SEC) break
    beforeSec = afterSec + Math.max(MIN_WINDOW_SEC, Math.floor(spanSec / 2))
    // 좁히는 동안은 한 페이지(LIST_PAGE_SIZE)에 다 들어오는지만 확인 — 요청 1회/단계
    listed = await fetchInboxMessageIds(ctx.accessToken, afterSec, beforeSec, LIST_PAGE_SIZE)
  }
  if (listed.truncated) {
    // MIN_WINDOW_SEC 안에 LIST_PAGE_SIZE 통 초과 — 사실상 발생 불가. 수집분만 처리.
    console.warn(
      '[check-inbox] list window still truncated uid=',
      ctx.userId,
      'after=',
      afterSec,
      'before=',
      beforeSec,
    )
  }

  // Gmail list 는 최신순 → 뒤집어 오래된 순으로 처리
  const idsOldestFirst = listed.ids.slice().reverse()
  const outcomes = await processMessages(ctx, idsOldestFirst)

  const firstUnhandled = outcomes.findIndex((o) => !o.handled)
  const drained = firstUnhandled < 0 && !listed.truncated
  const prefixEnd = firstUnhandled < 0 ? outcomes.length : firstUnhandled
  let prefixMaxTs: number | null = null
  for (let i = 0; i < prefixEnd; i++) {
    const ts = outcomes[i].ts
    if (ts !== null && (prefixMaxTs === null || ts > prefixMaxTs)) prefixMaxTs = ts
  }

  const prevFloorMs = floorSecMs(prevCursorMs)
  let nextCursorMs: number
  if (drained && beforeSec !== null) {
    // 좁힌 창 [after, before) 를 다 비움 — 창 끝 직전부터 다음 구간 이어받음
    nextCursorMs = (beforeSec - 1) * 1000
  } else if (drained) {
    nextCursorMs = listedAt - CURSOR_OVERLAP_MS
  } else if (prefixMaxTs !== null) {
    nextCursorMs = floorSecMs(prefixMaxTs) - 1000
  } else {
    nextCursorMs = prevFloorMs // 진전 없음 — 다음 tick 에 같은 지점부터 재시도
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
    meta = await fetchMessageMeta(ctx.accessToken, msgId)
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
        p_auto_create_contact: !automated,
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

// 자동 발송/대량 메일 여부 — true 면 contact 자동 생성 안 함 (inbound 기록은 그대로)
function isAutomatedMessage(
  labels: string[],
  fromEmail: string,
  headers: Array<{ name: string; value: string }> | undefined,
): boolean {
  if (labels.some((l) => AUTOMATED_CATEGORY_LABELS.includes(l))) return true
  const localPart = fromEmail.split('@')[0] ?? ''
  if (AUTOMATED_LOCAL_PART_RE.test(localPart)) return true
  if (getHeader(headers, 'List-Unsubscribe') || getHeader(headers, 'List-Id')) return true
  const precedence = (getHeader(headers, 'Precedence') ?? '').trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true
  // RFC 3834 — auto-generated / auto-replied (부재중 회신 등). 'no' 는 사람이 보낸 메일.
  const autoSubmitted = (getHeader(headers, 'Auto-Submitted') ?? '').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return true
  return false
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
 * `in:inbox after:<afterSec> [before:<beforeSec>]` 의 message id (최신순) 를 nextPageToken 으로 수집.
 * maxIds 에 도달했는데 다음 페이지가 남아 있으면 truncated=true (수집분 밖에 더 오래된 메일 존재).
 */
async function fetchInboxMessageIds(
  accessToken: string,
  afterSec: number,
  beforeSec: number | null,
  maxIds: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const q = beforeSec !== null
    ? `in:inbox after:${afterSec} before:${beforeSec}`
    : `in:inbox after:${afterSec}`
  const ids: string[] = []
  let pageToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({ q, maxResults: String(LIST_PAGE_SIZE) })
    if (pageToken) params.set('pageToken', pageToken)
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new GmailHttpError(`Gmail list ${res.status}: ${body.slice(0, 200)}`, res.status)
    }
    const data = (await res.json()) as {
      messages?: Array<{ id: string }>
      nextPageToken?: string
    }
    for (const m of data.messages ?? []) ids.push(m.id)
    if (!data.nextPageToken) return { ids, truncated: false }
    if (ids.length >= maxIds) return { ids, truncated: true }
    pageToken = data.nextPageToken
  }
}

/**
 * History API: startHistoryId 이후 INBOX 에 추가된(messageAdded) 메시지 id 델타 (오래된 순).
 *   - entries: 메시지 id + 처음 등장한 history record 의 인덱스 (dedup)
 *   - records: 수집한 history record id (오래된 순) — 부분 처리 시 커서 전진 지점
 *   - historyId: 응답의 mailbox historyId (truncated=false 일 때만 커서로 사용 가능)
 *   - truncated: 페이지/개수 상한으로 뒤 record 를 다 못 모음
 * 404(만료)면 GmailHttpError throw → 호출자가 시간기반으로 폴백.
 */
async function fetchHistoryEntries(
  accessToken: string,
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
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
      maxResults: '500',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/history?${params.toString()}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 404 = startHistoryId 만료(가지치기됨). 호출자가 시간기반으로 폴백.
      throw new GmailHttpError(`Gmail history ${res.status}: ${body.slice(0, 150)}`, res.status)
    }
    const data = (await res.json()) as {
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
async function fetchCurrentHistoryId(accessToken: string): Promise<string> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new GmailHttpError(`Gmail getProfile ${res.status}`, res.status)
  const data = (await res.json()) as { historyId?: string }
  if (!data.historyId) throw new Error('no historyId in profile')
  return data.historyId
}

async function fetchMessageMeta(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    if (res.status === 404) return null
    throw new GmailHttpError(`Gmail get ${res.status}`, res.status)
  }
  return (await res.json()) as GmailMessage
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

async function refreshGoogleToken(storedToken: string): Promise<string> {
  const refreshToken = await decryptToken(storedToken)
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`token refresh ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('no access_token in refresh response')
  return data.access_token
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
