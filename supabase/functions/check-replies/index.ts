// Supabase Edge Function: check-replies
// ============================================================
// 역할
// ------------------------------------------------------------
// pg_cron 이 매 5분 POST /functions/v1/check-replies 로 호출한다.
// recipients.replied = FALSE 이면서 gmail_thread_id 가 존재하는 수신자를
// "마지막으로 체크된 시각이 오래된 순" 으로 한 묶음 집어서 각 Gmail thread 를
// threads.get 으로 조회 → 내가 보낸 것 외의 메시지가 있으면 답장으로 판정.
//
// 큐잉 전략
// ------------------------------------------------------------
// - idx_recipients_reply_check 가 partial index (status='sent' AND gmail_thread_id NOT NULL AND replied=FALSE)
//   + ORDER BY last_reply_check_at NULLS FIRST.
// - 체크 후에는 결과에 관계없이 last_reply_check_at 을 NOW() 로 회전 →
//   같은 수신자가 같은 tick 에 반복 조회되지 않고, 한 tick 에서 못 끝내도 다음 tick 이 이어받음.
// - 이렇게 하면 5분 cron × BATCH_SIZE 만큼씩 큐가 순환.
//   대량 수신자(수천~만 단위) 캠페인이면 한 수신자당 답장 감지 지연이 수 분~수십 분까지 벌어질 수 있음.
//   실시간 감지가 필요하면 Gmail push (watch API) 도입을 고려 — 현재는 pull 방식.
//
// 보안
// ------------------------------------------------------------
//   Authorization: Bearer <CRON_SECRET>  (pg_cron 주입)
//   profiles.google_refresh_token — service_role 로만 접근 가능
//
// 타임아웃 복원력
// ------------------------------------------------------------
//   pg_cron timeout_milliseconds=55000.
//   50초 예산 안에서만 처리하고, 남은 수신자는 다음 tick 에 이월.
//   락/재개 상태가 없으므로 send-scheduled-campaigns 만큼 복잡하지 않다 —
//   rotate(last_reply_check_at = NOW()) 가 곧 '체크 완료' 의 idempotent 마커.
//
// 집계
// ------------------------------------------------------------
//   신규 답장이 발견된 campaign 마다 마지막에 reply_count 재계산 (SELECT COUNT) →
//   read-modify-write 보다 race-safe.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

// 한 tick 당 최대 처리 시간 (ms). pg_cron 55s 컷 직전에 자진 종료.
const RUN_BUDGET_MS = 50_000
// Gmail threads.get 1회 호출 + DB update 여유 (예상 400~1500ms).
const GMAIL_CALL_BUDGET_MS = 2_000
// 한 번에 큐에서 집어올 후보 수. 5분마다 × BATCH_SIZE 개씩 순환.
const BATCH_SIZE = 150

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// join 결과. Supabase JS 는 단일 FK 조인일 때 객체/배열 둘 다 반환 가능.
interface Row {
  id: string
  campaign_id: string
  gmail_thread_id: string
  sent_at: string | null
  campaigns: { user_id: string } | { user_id: string }[] | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!CRON_SECRET) return json({ error: 'CRON_SECRET not configured' }, 500)
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${CRON_SECRET}`) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const runStartedAt = Date.now()

  try {
    // ------------------------------------------------------------
    // 1) 큐에서 BATCH_SIZE 개 집어오기
    // ------------------------------------------------------------
    // partial index idx_recipients_reply_check 로 커버되는 쿼리.
    // campaigns!inner 로 user_id 조인 (토큰 공유 그룹핑용).
    const { data: rowsRaw, error: qErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id, campaign_id, gmail_thread_id, sent_at, campaigns!inner(user_id)')
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null)
      .eq('replied', false)
      .order('last_reply_check_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE)

    if (qErr) throw qErr
    const rows = (rowsRaw ?? []) as Row[]
    if (rows.length === 0) {
      return json({ processed: 0, replies_found: 0, message: 'no candidates' })
    }

    // ------------------------------------------------------------
    // 2) user_id 별 그룹핑 — refresh_token → access_token 은 사용자당 1번만.
    // ------------------------------------------------------------
    const byUser = new Map<string, Row[]>()
    for (const r of rows) {
      const uid = userIdOf(r)
      if (!uid) continue
      if (!byUser.has(uid)) byUser.set(uid, [])
      byUser.get(uid)!.push(r)
    }

    // 결과 버퍼 — 한 번에 몰아서 DB 반영.
    const noReplyIds: string[] = [] // last_reply_check_at 만 갱신
    const repliedInfos: Array<{ id: string; repliedAtIso: string; cid: string }> = []
    const campaignIdsTouched = new Set<string>()
    let processed = 0
    let tokenErrors = 0
    let gmailErrors = 0

    // ------------------------------------------------------------
    // 3) 사용자 루프 — 각자의 access_token 으로 threads.get
    // ------------------------------------------------------------
    userLoop: for (const [userId, list] of byUser) {
      // 남은 예산 체크
      if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break

      // 3-1) profile 조회
      const { data: profile, error: pErr } = await supabase
        .schema('mailcaster')
        .from('profiles')
        .select('email, google_refresh_token')
        .eq('id', userId)
        .single()

      if (pErr || !profile?.google_refresh_token || !profile?.email) {
        // 토큰 없는 사용자 — 이번엔 스킵 (rotate 도 안 함: 재로그인 시 즉시 이어받게)
        console.warn('[check-replies] skip uid=', userId, 'no refresh_token')
        continue
      }

      const userEmail = (profile.email as string).toLowerCase()
      let accessToken: string
      try {
        accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
      } catch (e) {
        tokenErrors++
        console.warn(
          '[check-replies] token refresh failed uid=',
          userId,
          e instanceof Error ? e.message : e
        )
        // 토큰 이슈는 재시도 가능 — last_reply_check_at 건드리지 않음
        continue
      }

      // 3-2) 이 사용자의 수신자들 Gmail threads.get
      for (const r of list) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break userLoop

        try {
          const reply = await detectReply(accessToken, r, userEmail)
          processed++
          if (reply) {
            repliedInfos.push({
              id: r.id,
              repliedAtIso: reply.repliedAtIso,
              cid: r.campaign_id,
            })
            campaignIdsTouched.add(r.campaign_id)
          } else {
            noReplyIds.push(r.id)
          }
        } catch (e) {
          gmailErrors++
          console.warn(
            '[check-replies] gmail error rid=',
            r.id,
            e instanceof Error ? e.message : e
          )
          // 일시적 오류도 rotate → 같은 수신자가 큐를 막지 않도록
          noReplyIds.push(r.id)
        }
      }
    }

    // ------------------------------------------------------------
    // 4) DB 반영 — 배치로 한 번에
    // ------------------------------------------------------------
    const nowIso = new Date().toISOString()

    // 4-1) 답장 확인된 수신자 — 개별 update (replied_at 이 행마다 다름)
    for (const info of repliedInfos) {
      const { error } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          replied: true,
          replied_at: info.repliedAtIso,
          last_reply_check_at: nowIso,
        })
        .eq('id', info.id)
      if (error) console.warn('[check-replies] markReplied fail', info.id, error.message)
    }

    // 4-2) 답장 없음 — 한 번에 rotate
    if (noReplyIds.length > 0) {
      const { error } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ last_reply_check_at: nowIso })
        .in('id', noReplyIds)
      if (error) console.warn('[check-replies] rotate fail', error.message)
    }

    // 4-3) 신규 답장이 발견된 campaign 의 reply_count 재계산
    //   read-modify-write 대신 COUNT(*) → idempotent + race-safe
    for (const cid of campaignIdsTouched) {
      const { count, error: cErr } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', cid)
        .eq('replied', true)
      if (cErr) {
        console.warn('[check-replies] count fail', cid, cErr.message)
        continue
      }
      const { error: uErr } = await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({ reply_count: count ?? 0 })
        .eq('id', cid)
      if (uErr) console.warn('[check-replies] reply_count update fail', cid, uErr.message)
    }

    return json({
      processed,
      replies_found: repliedInfos.length,
      no_reply: noReplyIds.length,
      token_errors: tokenErrors,
      gmail_errors: gmailErrors,
      users: byUser.size,
      batch_fetched: rows.length,
      elapsed_ms: Date.now() - runStartedAt,
    })
  } catch (e) {
    console.error('[check-replies] fatal:', e instanceof Error ? e.message : e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// ============================================================
// Gmail threads.get + 답장 판정
// ============================================================
//
// 판정 기준:
//   1) thread.messages.length >= 2  (내가 보낸 1통뿐이면 답장 없음)
//   2) internalDate > r.sent_at     (내 발송 이후 메시지)
//   3) From 헤더 이메일 != 내 이메일 (타인이 보낸 것)
//
// 3개 모두 만족하는 가장 이른 메시지의 시각을 replied_at 으로 사용.
// ============================================================
async function detectReply(
  accessToken: string,
  r: Row,
  userEmailLower: string
): Promise<{ repliedAtIso: string } | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(r.gmail_thread_id)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    // 404 → 스레드 삭제되었을 수 있음. 답장 없음으로 처리하고 rotate.
    if (res.status === 404) return null
    const body = await res.text().catch(() => '')
    throw new Error(`Gmail threads.get ${res.status}: ${body.slice(0, 200)}`)
  }

  const thread: {
    messages?: Array<{
      id: string
      internalDate?: string
      payload?: { headers?: Array<{ name: string; value: string }> }
    }>
  } = await res.json()

  const messages = thread.messages ?? []
  if (messages.length <= 1) return null

  const sentAtMs = r.sent_at ? Date.parse(r.sent_at) : 0

  // messages 는 시간순. 가장 이른 "타인 메시지" 를 answer 로 사용.
  //
  // 의도된 제외 (명시): 발송자 본인이 보낸 모든 메시지는 "답장" 이 아님.
  //   - 보낸 본인 메시지 (원본 + 후속 follow-up)
  //   - 테스트 목적의 self-send (자기 자신에게 메일 보낸 뒤 "답장" 클릭한 경우)
  //     이 또한 from == userEmail 이므로 감지 대상이 아님.
  //     → 자가 발송 캠페인은 답장 감지가 불가능함을 운영 문서에 기재.
  //
  // 주의: alias (myoungkyu.ho+test@amplitude.com) 는 다른 문자열이므로
  // "다른 사람 답장" 으로 잡힐 수 있음 — 드물지만 edge case.
  let earliestOtherMs: number | null = null
  for (const m of messages) {
    const ts = Number(m.internalDate ?? 0)
    if (!ts || ts <= sentAtMs) continue

    const from = extractFromHeader(m.payload?.headers)
    if (!from) continue
    if (from.toLowerCase() === userEmailLower) continue

    if (earliestOtherMs === null || ts < earliestOtherMs) earliestOtherMs = ts
  }
  if (earliestOtherMs === null) return null
  return { repliedAtIso: new Date(earliestOtherMs).toISOString() }
}

// RFC 5322 From header 에서 이메일 부분만 정확히 추출.
//   "Display Name <email@x.com>"       → email@x.com
//   "email@x.com"                      → email@x.com
//   "email@x.com (Display Name)"       → email@x.com   ← 괄호 주석 처리
//   '"Kim, J" <email@x.com>'            → email@x.com
// 실패 시 null 반환.
function extractFromHeader(
  headers?: Array<{ name: string; value: string }>
): string | null {
  if (!headers) return null
  const h = headers.find((x) => x.name.toLowerCase() === 'from')
  if (!h) return null
  // 1) angle-addr 우선: `<...>` 안쪽만 사용 (RFC 5322 name-addr)
  const angle = /<([^>]+)>/.exec(h.value)
  if (angle?.[1]) return angle[1].trim()
  // 2) 괄호 주석 제거 (RFC 5322 allows comments in addr-spec)
  //    "a@b.com (comment)" → "a@b.com"
  const withoutComments = h.value.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  // 3) 공백이 섞여 있으면 이메일로 보이는 첫 토큰만 취함
  const emailToken = /[^\s<>]+@[^\s<>]+/.exec(withoutComments)
  if (emailToken) return emailToken[0].trim()
  return withoutComments || null
}

function userIdOf(r: Row): string | null {
  const c = r.campaigns
  if (!c) return null
  if (Array.isArray(c)) return c[0]?.user_id ?? null
  return c.user_id ?? null
}

// ============================================================
// 공용 헬퍼 — send-scheduled-campaigns 와 동일 패턴
// ============================================================
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function refreshGoogleToken(refreshToken: string): Promise<string> {
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
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google OAuth 실패 (${res.status}): ${body}`)
  }
  const j = await res.json()
  if (!j.access_token) throw new Error('access_token 미반환')
  return j.access_token as string
}
