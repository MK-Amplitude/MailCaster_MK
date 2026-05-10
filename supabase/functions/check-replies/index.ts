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
// 답장 분류용 — 부재 시 분류 단계만 skip (감지/저장은 그대로 동작).
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
// 답장 분류는 짧은 input 으로 충분 — mini 가 비용/지연 최적.
const OPENAI_CLASSIFY_MODEL =
  Deno.env.get('REPLY_CLASSIFY_MODEL') ?? 'gpt-4o-mini'

// 한 tick 당 최대 처리 시간 (ms). pg_cron 55s 컷 직전에 자진 종료.
const RUN_BUDGET_MS = 50_000
// Gmail threads.get 1회 호출 + DB update 여유 (예상 400~1500ms).
const GMAIL_CALL_BUDGET_MS = 2_000
// 답장 분류 1건 추가 시간 (Gmail messages.get + OpenAI). 보수적 추정.
const CLASSIFY_BUDGET_MS = 2_500
// 한 번에 큐에서 집어올 후보 수. 5분마다 × BATCH_SIZE 개씩 순환.
const BATCH_SIZE = 150
// 답장 본문 LLM 으로 보낼 때 최대 길이 (긴 thread 의 quoted history 잘라냄).
const REPLY_BODY_MAX_CHARS = 2000

// Phase 11.1 — replied=true 행 thread 메타 갱신 (내가 답장했는지 등) 재방문 주기.
// 너무 짧으면 Gmail quota 부담, 너무 길면 "내 답장 대기" 인사이트 갱신 지연.
const THREAD_RECHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000  // 6시간
// pass2 batch — 같은 tick 에서 pass1 끝나고 남은 예산으로 처리.
const PASS2_BATCH_SIZE = 50

type ReplyCategory =
  | 'interested'
  | 'not_interested'
  | 'question'
  | 'out_of_office'
  | 'unclear'

const VALID_CATEGORIES = new Set<ReplyCategory>([
  'interested',
  'not_interested',
  'question',
  'out_of_office',
  'unclear',
])

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
    const repliedInfos: Array<{
      id: string
      repliedAtIso: string
      cid: string
      category: ReplyCategory
      meta: ThreadMeta
    }> = []
    const campaignIdsTouched = new Set<string>()
    let processed = 0
    let tokenErrors = 0
    let gmailErrors = 0
    let classifyErrors = 0
    let pass2Updated = 0

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
            // 답장 본문 분류 — 실패해도 'unclear' 로 기록하고 진행 (감지 자체는 보존).
            // 분류 예산 잔량이 부족하면 skip ('unclear' 저장) — 다음 cron tick 에선
            // replied=true 가 되어 분류 큐에서 제외되니, 사실상 한 번에 처리.
            let category: ReplyCategory = 'unclear'
            const remainingMs = RUN_BUDGET_MS - (Date.now() - runStartedAt)
            if (remainingMs > CLASSIFY_BUDGET_MS) {
              try {
                category = await classifyReply(accessToken, reply.messageId)
              } catch (e) {
                classifyErrors++
                console.warn(
                  '[check-replies] classify error rid=',
                  r.id,
                  e instanceof Error ? e.message : e
                )
              }
            }
            repliedInfos.push({
              id: r.id,
              repliedAtIso: reply.repliedAtIso,
              cid: r.campaign_id,
              category,
              meta: reply.meta,
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

    // 4-1) 답장 확인된 수신자 — 개별 update (replied_at + reply_category + thread meta)
    for (const info of repliedInfos) {
      const { error } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          replied: true,
          replied_at: info.repliedAtIso,
          reply_category: info.category,
          last_reply_check_at: nowIso,
          last_thread_message_at: info.meta.lastMessageAtIso,
          last_thread_message_from_me: info.meta.lastMessageFromMe,
          thread_message_count: info.meta.messageCount,
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

    // ------------------------------------------------------------
    // pass 2 — replied=true 행 thread 메타 갱신 (cooldown 6h)
    // 영업 가치: "내 답장 대기" 인사이트가 갱신됨.
    // ------------------------------------------------------------
    if (Date.now() - runStartedAt < RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) {
      const cooldownIso = new Date(Date.now() - THREAD_RECHECK_COOLDOWN_MS).toISOString()
      const { data: pass2Raw } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .select('id, campaign_id, gmail_thread_id, sent_at, campaigns!inner(user_id)')
        .eq('replied', true)
        .not('gmail_thread_id', 'is', null)
        .or(`last_reply_check_at.is.null,last_reply_check_at.lt.${cooldownIso}`)
        .order('last_reply_check_at', { ascending: true, nullsFirst: true })
        .limit(PASS2_BATCH_SIZE)
      const pass2Rows = (pass2Raw ?? []) as Row[]

      // user_id 별 access_token 캐시 — pass1 에서 이미 만들어진 토큰을 재활용 안 하지만
      // pass2 batch 가 작아 user 별 1번 refresh 가 비싸지 않음.
      const pass2ByUser = new Map<string, Row[]>()
      for (const r of pass2Rows) {
        const uid = userIdOf(r)
        if (!uid) continue
        if (!pass2ByUser.has(uid)) pass2ByUser.set(uid, [])
        pass2ByUser.get(uid)!.push(r)
      }

      pass2Loop: for (const [userId, list] of pass2ByUser) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break
        const { data: profile } = await supabase
          .schema('mailcaster')
          .from('profiles')
          .select('email, google_refresh_token')
          .eq('id', userId)
          .single()
        if (!profile?.google_refresh_token || !profile?.email) continue
        let accessToken: string
        try {
          accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
        } catch {
          continue
        }
        const userEmailLower = (profile.email as string).toLowerCase()

        for (const r of list) {
          if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break pass2Loop
          try {
            const analysis = await fetchThreadAnalysis(accessToken, r, userEmailLower)
            if (!analysis) {
              // thread 삭제됨 — last_reply_check_at 만 갱신해 큐 회전
              await supabase
                .schema('mailcaster')
                .from('recipients')
                .update({ last_reply_check_at: nowIso })
                .eq('id', r.id)
              continue
            }
            const { error: uErr } = await supabase
              .schema('mailcaster')
              .from('recipients')
              .update({
                last_reply_check_at: nowIso,
                last_thread_message_at: analysis.meta.lastMessageAtIso,
                last_thread_message_from_me: analysis.meta.lastMessageFromMe,
                thread_message_count: analysis.meta.messageCount,
              })
              .eq('id', r.id)
            if (!uErr) pass2Updated++
          } catch (e) {
            console.warn(
              '[check-replies pass2] gmail error rid=',
              r.id,
              e instanceof Error ? e.message : e
            )
            // 일시 오류여도 last_reply_check_at 갱신해 큐 회전
            await supabase
              .schema('mailcaster')
              .from('recipients')
              .update({ last_reply_check_at: nowIso })
              .eq('id', r.id)
          }
        }
      }
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
      classify_errors: classifyErrors,
      pass2_updated: pass2Updated,
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
interface ThreadMeta {
  lastMessageAtIso: string
  lastMessageFromMe: boolean
  messageCount: number
}

interface ThreadAnalysis {
  // 답장이 있으면 (가장 이른 타인 메시지)
  reply: { repliedAtIso: string; messageId: string } | null
  // thread 전체 메타 (마지막 메시지 시각/발신자/총 개수)
  meta: ThreadMeta
}

async function fetchThreadAnalysis(
  accessToken: string,
  r: Row,
  userEmailLower: string
): Promise<ThreadAnalysis | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(r.gmail_thread_id)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
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
  if (messages.length === 0) return null

  // 가장 늦은 메시지 — 마지막 활동 시각 + 발신자
  let lastMs = 0
  let lastFromMe = false
  let earliestOther: { ms: number; messageId: string } | null = null
  const sentAtMs = r.sent_at ? Date.parse(r.sent_at) : 0

  for (const m of messages) {
    const ts = Number(m.internalDate ?? 0)
    if (!ts) continue
    const from = (extractFromHeader(m.payload?.headers) ?? '').toLowerCase()
    const fromMe = from === userEmailLower
    // 가장 늦은 메시지 추적
    if (ts > lastMs) {
      lastMs = ts
      lastFromMe = fromMe
    }
    // 답장 후보: 발송 이후 + 타인 발 + 가장 이른 메시지
    if (!fromMe && ts > sentAtMs) {
      if (earliestOther === null || ts < earliestOther.ms) {
        earliestOther = { ms: ts, messageId: m.id }
      }
    }
  }

  return {
    reply: earliestOther
      ? {
          repliedAtIso: new Date(earliestOther.ms).toISOString(),
          messageId: earliestOther.messageId,
        }
      : null,
    meta: {
      lastMessageAtIso: lastMs > 0 ? new Date(lastMs).toISOString() : new Date().toISOString(),
      lastMessageFromMe: lastFromMe,
      messageCount: messages.length,
    },
  }
}

async function detectReply(
  accessToken: string,
  r: Row,
  userEmailLower: string
): Promise<{ repliedAtIso: string; messageId: string; meta: ThreadMeta } | null> {
  const analysis = await fetchThreadAnalysis(accessToken, r, userEmailLower)
  if (!analysis || !analysis.reply) return null
  return {
    repliedAtIso: analysis.reply.repliedAtIso,
    messageId: analysis.reply.messageId,
    meta: analysis.meta,
  }
}

// ============================================================
// Gmail messages.get + OpenAI 분류
// ============================================================
// 1) Gmail API 로 답장 메시지 본문 (text/plain 우선, fallback text/html stripped)
// 2) 인용 부분(>로 시작하는 라인) 과 시그니처 영역을 휴리스틱으로 제거 → 본문만 남김
// 3) OpenAI 로 5분류 — 짧은 system prompt, 50~100 token 응답.
async function classifyReply(
  accessToken: string,
  messageId: string
): Promise<ReplyCategory> {
  if (!OPENAI_API_KEY) return 'unclear'

  const text = await fetchReplyBody(accessToken, messageId)
  const trimmed = stripQuotedAndSignature(text).slice(0, REPLY_BODY_MAX_CHARS)
  if (!trimmed.trim()) return 'unclear'

  const systemPrompt = `당신은 한국어 B2B 영업 답장의 톤을 5가지로 분류합니다.
입력은 답장 본문(인용/서명 제거됨). 출력은 JSON: {"category": "..."}.

분류:
- interested      : 관심 표현·미팅 의향·후속 컨택 동의·긍정 응답
- not_interested  : 정중한 거절·관심 없음·이미 충분함·다음 기회
- question        : 구체적 질문·자료 요청·일정·가격·기능 문의
- out_of_office   : 자동응답·휴가·부재중·자리 비움·자동 회신
- unclear         : 위에 안 맞거나 톤이 모호

규칙:
1) 반드시 위 5개 중 하나.
2) JSON 외 다른 출력 금지.`

  const userPrompt = `답장 본문:\n"""\n${trimmed}\n"""\n\n위 5개 중 하나로 분류:`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_CLASSIFY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 30,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  let parsed: { category?: string } = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'unclear'
  }
  const cat = parsed.category as ReplyCategory | undefined
  if (cat && VALID_CATEGORIES.has(cat)) return cat
  return 'unclear'
}

async function fetchReplyBody(accessToken: string, messageId: string): Promise<string> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    throw new Error(`Gmail messages.get ${res.status}`)
  }
  const msg = (await res.json()) as {
    payload?: GmailPart
  }
  const body = extractTextBody(msg.payload)
  return body ?? ''
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

// 재귀적으로 text/plain → text/html (HTML 태그 제거) 순으로 본문 추출.
function extractTextBody(part?: GmailPart): string | null {
  if (!part) return null
  // text/plain 우선
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data)
  }
  // multipart: 자식들 재귀 — text/plain 우선, 없으면 text/html
  if (part.parts && part.parts.length > 0) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        return decodeBase64Url(p.body.data)
      }
    }
    for (const p of part.parts) {
      const nested = extractTextBody(p)
      if (nested) return nested
    }
    for (const p of part.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) {
        return stripHtml(decodeBase64Url(p.body.data))
      }
    }
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data))
  }
  return null
}

function decodeBase64Url(s: string): string {
  // Gmail base64url → 표준 base64
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  try {
    // atob → bytes → utf-8 디코딩
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

// 인용(>로 시작) + Gmail 의 "On … wrote:" 헤더 + 시그니처 구분자(--) 이후 제거.
// 휴리스틱이라 100% 정확하진 않지만 LLM 입력의 노이즈를 크게 줄여줌.
function stripQuotedAndSignature(text: string): string {
  // 1) "On {date}, {name} wrote:" / "{date} ... 작성:" 같은 답장 헤더 이후를 자르기
  const replyHeaderPatterns = [
    /\n\s*On .+ wrote:[\s\S]*$/m,
    /\n\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[\s\S]+(작성|wrote|쓴 글|보낸 메일):[\s\S]*$/m,
    /\n\s*-+\s*Original Message\s*-+[\s\S]*$/im,
    /\n\s*From:.+\nSent:.+[\s\S]*$/im,
  ]
  let out = text
  for (const re of replyHeaderPatterns) out = out.replace(re, '')

  // 2) 시그니처 구분자 (-- 단독 라인) 이후 제거
  out = out.replace(/\n--\s*\n[\s\S]*$/m, '')

  // 3) 인용된 라인 (> 로 시작) 제거
  out = out
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')

  return out.trim()
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
