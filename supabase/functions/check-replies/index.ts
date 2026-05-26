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
// pass3 batch — thread_messages (팔로업/회신/전달) 의 회신 폴링. pass1/pass2 다음 잔여 예산으로.
const PASS3_BATCH_SIZE = 50
// Gmail messages.get (회신 본문 + 헤더 조회) 예산.
const REPLY_META_BUDGET_MS = 1_500
// pass3 의 cooldown — thread_messages 의 다중 회신 감지를 위해 replied 상태 무관하게 재방문.
// pass2 (6시간) 와 같은 값. 너무 짧으면 Gmail quota 부담, 너무 길면 후속 회신 발견 지연.
const THREAD_MSG_RECHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000

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
  email: string
  contact_id: string | null
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
      .select('id, campaign_id, gmail_thread_id, sent_at, email, contact_id, campaigns!inner(user_id)')
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null)
      .eq('replied', false)
      .eq('bounced', false)
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
    // 반송된 수신자 — recipient 와 contact 양쪽 갱신.
    const bouncedInfos: Array<{
      id: string
      bouncedAtIso: string
      cid: string
      reason: string
      recipientEmail: string
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
          const result = await detectReplyOrBounce(accessToken, r, userEmail)
          processed++
          if (result?.kind === 'bounce') {
            // 반송 — bounce body 에서 reason 추출 (실패해도 최소 from 정보 기록)
            let reason = `Bounced from ${result.from}`
            try {
              const body = await fetchReplyBody(accessToken, result.messageId)
              const firstLine = extractBounceReason(body)
              if (firstLine) reason = firstLine
            } catch {
              // body 못 가져와도 진행 — from 정보만으로 기록
            }
            bouncedInfos.push({
              id: r.id,
              bouncedAtIso: result.bouncedAtIso,
              cid: r.campaign_id,
              reason: reason.slice(0, 500),
              recipientEmail: r.email,
            })
            campaignIdsTouched.add(r.campaign_id)
          } else if (result?.kind === 'reply') {
            // 답장 본문 분류 — 실패해도 'unclear' 로 기록하고 진행 (감지 자체는 보존).
            // 분류 예산 잔량이 부족하면 skip ('unclear' 저장) — 다음 cron tick 에선
            // replied=true 가 되어 분류 큐에서 제외되니, 사실상 한 번에 처리.
            let category: ReplyCategory = 'unclear'
            const remainingMs = RUN_BUDGET_MS - (Date.now() - runStartedAt)
            if (remainingMs > CLASSIFY_BUDGET_MS) {
              try {
                category = await classifyReply(accessToken, result.messageId)
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
              repliedAtIso: result.repliedAtIso,
              cid: r.campaign_id,
              category,
              meta: result.meta,
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

    // 4-3) 반송 처리 — recipient 와 contact 동시 갱신.
    //  - recipient.bounced=true + bounced_at + bounce_reason + status='bounced'
    //  - contact.is_bounced=true + bounce_count++ + last_bounced_at (email 기준 같은 org 모두)
    //  - 같은 사람 여러 캠페인에서 반송되면 bounce_count 누적
    for (const b of bouncedInfos) {
      const { error: rErr } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          bounced: true,
          bounced_at: b.bouncedAtIso,
          bounce_reason: b.reason,
          last_reply_check_at: nowIso,
        })
        .eq('id', b.id)
      if (rErr) {
        console.warn('[check-replies] markBounced recipient fail', b.id, rErr.message)
        continue
      }

      // contact 업데이트 — 같은 org 의 같은 email 모두 (멤버별 사본 일관성)
      // org 식별: recipients → campaigns → org_id 가 같은 contacts
      const { data: campaignRow } = await supabase
        .schema('mailcaster')
        .from('campaigns')
        .select('org_id')
        .eq('id', b.cid)
        .maybeSingle()
      const orgId = campaignRow?.org_id as string | undefined
      if (!orgId) continue

      // 기존 bounce_count 가져와서 +1
      const { data: cRows } = await supabase
        .schema('mailcaster')
        .from('contacts')
        .select('id, bounce_count')
        .eq('org_id', orgId)
        .ilike('email', b.recipientEmail)
      if (!cRows || cRows.length === 0) continue
      for (const c of cRows) {
        const newCount = (Number(c.bounce_count) || 0) + 1
        await supabase
          .schema('mailcaster')
          .from('contacts')
          .update({
            is_bounced: true,
            bounce_count: newCount,
            last_bounced_at: b.bouncedAtIso,
          })
          .eq('id', c.id)
      }
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

    // ------------------------------------------------------------
    // pass 3 — thread_messages (팔로업/회신/전달) 의 회신 폴링 (다중 회신 정확 매핑)
    // ------------------------------------------------------------
    // 설계:
    //   - 같은 (user_id, gmail_thread_id) 의 thread_message 들을 그룹핑 → 한 thread 당 Gmail
    //     threads.get 한 번만 호출 (rate limit 절감).
    //   - In-Reply-To / References 헤더 분석으로 어느 thread_message 의 응답인지 정확히 매핑.
    //     매칭 실패 시 receivedAt 직전 sent_at 의 thread_message 로 fallback.
    //   - body_text 는 stripQuotedAndSignature 적용 후 저장 → 재귀 회신 시 quote 폭발 방지.
    //   - 회신 발견 시 그 회신의 campaign_id 를 campaignIdsTouched 에 추가 → campaign.reply_count 재계산.
    //   - 부분 break 시 last_reply_check_at 갱신 skip → 다음 cron 즉시 재시도.
    let pass3Processed = 0
    let pass3RepliesFound = 0
    let pass3ThreadsProcessed = 0
    if (Date.now() - runStartedAt < RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) {
      const pass3CooldownIso = new Date(Date.now() - THREAD_MSG_RECHECK_COOLDOWN_MS).toISOString()
      const { data: pass3Raw } = await supabase
        .schema('mailcaster')
        .from('thread_messages')
        .select('id, org_id, user_id, gmail_thread_id, gmail_message_id, rfc_message_id, in_reply_to_message_id, campaign_id, sent_at')
        .eq('status', 'sent')
        .not('gmail_thread_id', 'is', null)
        .or(`last_reply_check_at.is.null,last_reply_check_at.lt.${pass3CooldownIso}`)
        .order('last_reply_check_at', { ascending: true, nullsFirst: true })
        .limit(PASS3_BATCH_SIZE)
      type Tm3Row = {
        id: string
        org_id: string
        user_id: string | null
        gmail_thread_id: string
        gmail_message_id: string | null
        rfc_message_id: string | null         // 우리가 보낸 메시지의 RFC 2822 Message-ID (A 답장 In-Reply-To)
        in_reply_to_message_id: string | null  // 우리가 응답한 원본의 RFC Message-ID (보조 매칭용)
        campaign_id: string | null
        sent_at: string | null
      }
      const pass3Rows = (pass3Raw ?? []) as Tm3Row[]

      // (user_id, gmail_thread_id) 별 그룹핑 — 같은 thread 의 tm 들을 한 번에 처리
      const pass3ByThread = new Map<string, Tm3Row[]>()
      for (const r of pass3Rows) {
        if (!r.user_id) continue
        const key = `${r.user_id}|${r.gmail_thread_id}`
        if (!pass3ByThread.has(key)) pass3ByThread.set(key, [])
        pass3ByThread.get(key)!.push(r)
      }

      // user_id 별로 access_token refresh 캐시 — 같은 user 의 여러 thread 가 토큰 재발급 안 해도 되도록
      const tokenCache = new Map<string, { token: string; emailLower: string } | null>()
      const getUserAuth = async (
        userId: string,
      ): Promise<{ token: string; emailLower: string } | null> => {
        if (tokenCache.has(userId)) return tokenCache.get(userId)!
        const { data: profile } = await supabase
          .schema('mailcaster')
          .from('profiles')
          .select('email, google_refresh_token')
          .eq('id', userId)
          .single()
        if (!profile?.google_refresh_token || !profile?.email) {
          tokenCache.set(userId, null)
          return null
        }
        try {
          const token = await refreshGoogleToken(profile.google_refresh_token as string)
          const auth = { token, emailLower: (profile.email as string).toLowerCase() }
          tokenCache.set(userId, auth)
          return auth
        } catch {
          tokenCache.set(userId, null)
          return null
        }
      }

      for (const [key, group] of pass3ByThread) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS - REPLY_META_BUDGET_MS) break

        const userId = key.split('|')[0]
        const auth = await getUserAuth(userId)
        if (!auth) {
          // 토큰 없음 — last_reply_check_at 건드리지 않고 다음 cron 으로 이월
          continue
        }

        // 그룹 내 sent_at 가장 이른 tm 의 timestamp = thread 폴링의 floor
        const earliestSentAtMs = Math.min(
          ...group.map((r) => (r.sent_at ? Date.parse(r.sent_at) : Number.MAX_SAFE_INTEGER)),
        )
        const threadId = group[0].gmail_thread_id

        // 이미 저장된 이 thread 의 회신들 — group 전체 tm 의 reply 를 모음
        const tmIds = group.map((r) => r.id)
        const { data: knownRaw } = await supabase
          .schema('mailcaster')
          .from('thread_message_replies')
          .select('gmail_message_id')
          .in('thread_message_id', tmIds)
        const knownIds = new Set(
          (knownRaw ?? []).map((k: { gmail_message_id: string }) => k.gmail_message_id),
        )

        let partialBreak = false
        try {
          const newReplies = await fetchThreadAllNewReplies(
            auth.token,
            threadId,
            earliestSentAtMs,
            auth.emailLower,
            knownIds,
          )
          pass3ThreadsProcessed++

          // 각 새 회신마다: In-Reply-To 매칭 + 본문 페치 + RPC
          for (const nr of newReplies) {
            if (Date.now() - runStartedAt > RUN_BUDGET_MS - REPLY_META_BUDGET_MS) {
              partialBreak = true
              break
            }
            pass3Processed++

            // 대상 tm 결정 (정확도 순):
            //   1) In-Reply-To / References 가 group 의 어떤 tm 의 rfc_message_id 와 매칭
            //      (= A 가 응답한 우리 메시지의 RFC Message-ID. 가장 정확.)
            //   2) References 가 group 의 다른 RFC id (in_reply_to_message_id) 와 매칭
            //      (= 우리 thread_message 가 응답했던 원본 — 같은 thread 의 상위 메시지)
            //   3) receivedAt 직전 sent_at 의 tm (chronological fallback)
            let targetTm: Tm3Row | null = null
            const candidates = [nr.inReplyTo, ...nr.references].filter(
              (v): v is string => !!v,
            )
            // 1순위
            for (const ref of candidates) {
              const matched = group.find((g) => g.rfc_message_id === ref)
              if (matched) {
                targetTm = matched
                break
              }
            }
            // 2순위 (보조)
            if (!targetTm) {
              for (const ref of candidates) {
                const matched = group.find((g) => g.in_reply_to_message_id === ref)
                if (matched) {
                  targetTm = matched
                  break
                }
              }
            }
            // 3순위 — chronological fallback
            if (!targetTm) {
              const sortedBySentAt = [...group].sort((a, b) => {
                const ta = a.sent_at ? Date.parse(a.sent_at) : 0
                const tb = b.sent_at ? Date.parse(b.sent_at) : 0
                return tb - ta // DESC
              })
              targetTm =
                sortedBySentAt.find((g) => {
                  const sentMs = g.sent_at ? Date.parse(g.sent_at) : Number.MAX_SAFE_INTEGER
                  return sentMs <= nr.receivedAtMs
                }) ?? sortedBySentAt[sortedBySentAt.length - 1]
            }
            if (!targetTm) continue

            // 본문/메타 fetch
            let meta: ReplyMeta | null = null
            try {
              meta = await fetchReplyMeta(auth.token, nr.messageId)
            } catch (e) {
              console.warn(
                '[check-replies pass3] reply meta fetch fail tmid=',
                targetTm.id,
                'mid=',
                nr.messageId,
                e instanceof Error ? e.message : e,
              )
            }
            const fromParsed = parseFromAddress(meta?.from ?? null)
            // body_text 에서 quote/signature 제거 → 재귀 회신 시 폭발 방지
            const cleanBody = stripQuoteForStorage(meta?.bodyText ?? '').slice(
              0,
              REPLY_BODY_MAX_CHARS,
            )
            const { data: rpcOk, error: rpcErr } = await supabase
              .schema('mailcaster')
              .rpc('record_thread_reply', {
                p_thread_message_id: targetTm.id,
                p_org_id: targetTm.org_id,
                p_gmail_message_id: nr.messageId,
                p_gmail_thread_id: threadId,
                p_rfc_message_id: meta?.rfcMessageId ?? null,
                p_from_email: fromParsed.email,
                p_from_name: fromParsed.name,
                p_subject: meta?.subject ?? null,
                p_snippet: meta?.snippet ?? null,
                p_body_text: cleanBody,
                p_received_at: nr.receivedAtIso,
              })
            if (rpcErr) {
              console.warn(
                '[check-replies pass3] record_thread_reply rpc error tmid=',
                targetTm.id,
                rpcErr.message,
              )
            } else if (rpcOk === true) {
              pass3RepliesFound++
              // 캠페인 통계 — 회신 추가된 thread_message 의 campaign 도 갱신
              if (targetTm.campaign_id) campaignIdsTouched.add(targetTm.campaign_id)
            }
          }

          // 부분 break 가 아니면 group 의 모든 tm 에 대해 last_reply_check_at 회전.
          // partialBreak 인 경우 — rotate 하지 않고 다음 cron 이 즉시 재시도하게 함.
          if (!partialBreak) {
            for (const r of group) {
              await supabase
                .schema('mailcaster')
                .from('thread_messages')
                .update({ last_reply_check_at: nowIso })
                .eq('id', r.id)
            }
          }
        } catch (e) {
          console.warn(
            '[check-replies pass3] thread error key=',
            key,
            e instanceof Error ? e.message : e,
          )
          // gmail 오류는 rotate 해서 큐 회전 (한 thread 가 큐 막지 않게)
          for (const r of group) {
            await supabase
              .schema('mailcaster')
              .from('thread_messages')
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
      pass3_processed: pass3Processed,
      pass3_replies_found: pass3RepliesFound,
      pass3_threads_processed: pass3ThreadsProcessed,
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
  // 반송이 감지되면 (mailer-daemon 등이 가장 이른 메시지로 옴) — reply 보다 우선 처리.
  bounce: { bouncedAtIso: string; messageId: string; from: string } | null
  // thread 전체 메타 (마지막 메시지 시각/발신자/총 개수)
  meta: ThreadMeta
}

// 발송 후 thread 에 들어온 메시지의 From 헤더가 이 패턴이면 반송으로 판정.
// 정상 답장에는 절대 안 들어오는 표준 메일 시스템 주소들.
const BOUNCE_FROM_PATTERNS = [
  /mailer-daemon@/i,
  /postmaster@/i,
  /<mailer-daemon@/i,
  /^mailer-daemon\b/i,
  /noreply.*bounce/i,
]

function isBounceFrom(from: string): boolean {
  if (!from) return false
  return BOUNCE_FROM_PATTERNS.some((p) => p.test(from))
}

// fetchThreadAnalysis 는 사실상 gmail_thread_id 와 sent_at 만 쓴다.
// Row 전체를 받으면 (recipients 와 thread_messages) 둘을 호환할 때 `as any` 가 필요해지므로
// 좁은 인터페이스로 한정.
interface ThreadAnalysisInput {
  gmail_thread_id: string
  sent_at: string | null
}

async function fetchThreadAnalysis(
  accessToken: string,
  r: ThreadAnalysisInput,
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
  let earliestOther: { ms: number; messageId: string; from: string } | null = null
  let earliestBounce: { ms: number; messageId: string; from: string } | null = null
  const sentAtMs = r.sent_at ? Date.parse(r.sent_at) : 0

  for (const m of messages) {
    const ts = Number(m.internalDate ?? 0)
    if (!ts) continue
    const fromRaw = extractFromHeader(m.payload?.headers) ?? ''
    const from = fromRaw.toLowerCase()
    const fromMe = from === userEmailLower
    // 가장 늦은 메시지 추적
    if (ts > lastMs) {
      lastMs = ts
      lastFromMe = fromMe
    }
    // 발송 이후 + 타인 발 메시지만 후보
    if (!fromMe && ts > sentAtMs) {
      if (isBounceFrom(fromRaw)) {
        // 반송 메시지 — 가장 이른 것 채택. reply 후보에선 제외.
        if (earliestBounce === null || ts < earliestBounce.ms) {
          earliestBounce = { ms: ts, messageId: m.id, from: fromRaw }
        }
      } else {
        // 정상 답장 후보
        if (earliestOther === null || ts < earliestOther.ms) {
          earliestOther = { ms: ts, messageId: m.id, from: fromRaw }
        }
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
    bounce: earliestBounce
      ? {
          bouncedAtIso: new Date(earliestBounce.ms).toISOString(),
          messageId: earliestBounce.messageId,
          from: earliestBounce.from,
        }
      : null,
    meta: {
      lastMessageAtIso: lastMs > 0 ? new Date(lastMs).toISOString() : new Date().toISOString(),
      lastMessageFromMe: lastFromMe,
      messageCount: messages.length,
    },
  }
}

// 답장 또는 반송 감지 — 둘 다 없으면 null. 둘 다 있으면 반송 우선 (먼저 보낸 메일이 반송된 경우).
async function detectReplyOrBounce(
  accessToken: string,
  r: Row,
  userEmailLower: string
): Promise<
  | {
      kind: 'reply'
      repliedAtIso: string
      messageId: string
      meta: ThreadMeta
    }
  | {
      kind: 'bounce'
      bouncedAtIso: string
      messageId: string
      from: string
      meta: ThreadMeta
    }
  | null
> {
  const analysis = await fetchThreadAnalysis(accessToken, r, userEmailLower)
  if (!analysis) return null
  if (analysis.bounce) {
    return {
      kind: 'bounce',
      bouncedAtIso: analysis.bounce.bouncedAtIso,
      messageId: analysis.bounce.messageId,
      from: analysis.bounce.from,
      meta: analysis.meta,
    }
  }
  if (analysis.reply) {
    return {
      kind: 'reply',
      repliedAtIso: analysis.reply.repliedAtIso,
      messageId: analysis.reply.messageId,
      meta: analysis.meta,
    }
  }
  return null
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

분류 (보수적으로 — 애매하면 unclear):
- interested      : 명시적 미팅·통화·데모 동의 또는 구체적 다음 액션 약속.
                    예) "다음 주 화요일 미팅 가능합니다", "30분 통화 잡아주세요",
                         "데모 받고 싶습니다", "방문해주세요". 관심·미팅 의향이
                         확정 단계에 들어가야만 이 카테고리.
                    NOT interested: "참고하겠습니다", "검토 후 연락드리겠습니다",
                         "나중에 필요하면 연락드릴게요", "감사합니다", "확인했습니다",
                         "관심은 있는데 지금은 어렵습니다" — 이런 미온적/연기성
                         답변은 절대 interested 가 아님. unclear 또는 not_interested.
- not_interested  : 정중한 거절·관심 없음·이미 충분함·다음 기회·예산 없음
- question        : 구체적 질문·자료 요청·가격·기능 문의 (미팅 약속은 아님)
- out_of_office   : 자동응답·휴가·부재중·자리 비움·자동 회신
- unclear         : 위에 안 맞거나 톤이 모호 — 단순 회신·인사·"알겠습니다" 류 포함

규칙:
1) 반드시 위 5개 중 하나.
2) interested 는 보수적으로 — 약속·동의·구체적 액션이 명확할 때만.
3) JSON 외 다른 출력 금지.`

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

// pass3 (thread_messages 회신) 용 — body + 주요 헤더 + snippet 한 번에.
interface ReplyMeta {
  from: string | null
  subject: string | null
  rfcMessageId: string | null
  snippet: string | null
  bodyText: string
}
async function fetchReplyMeta(accessToken: string, messageId: string): Promise<ReplyMeta> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    throw new Error(`Gmail messages.get ${res.status}`)
  }
  const msg = (await res.json()) as {
    snippet?: string
    payload?: GmailPart & { headers?: Array<{ name: string; value: string }> }
  }
  const headers = msg.payload?.headers ?? []
  const getH = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  return {
    snippet: msg.snippet ?? null,
    from: getH('From'),
    subject: getH('Subject'),
    rfcMessageId: getH('Message-ID') ?? getH('Message-Id'),
    bodyText: extractTextBody(msg.payload) ?? '',
  }
}

// pass3 전용 — earliestThreadMessageSentAtMs 이후 + 타인 발신 + knownMessageIds 에 없는 메시지 전부.
// In-Reply-To / References 헤더도 함께 가져옴 — 다중 회신을 정확한 tm 에 매핑하기 위함.
async function fetchThreadAllNewReplies(
  accessToken: string,
  threadId: string,
  earliestSentAtMs: number,
  userEmailLower: string,
  knownMessageIds: Set<string>,
): Promise<Array<{
  messageId: string
  receivedAtIso: string
  receivedAtMs: number
  inReplyTo: string | null
  references: string[]
}>> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=In-Reply-To&metadataHeaders=References`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    if (res.status === 404) return [] // thread 삭제됨
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
  const getH = (
    headers: Array<{ name: string; value: string }> | undefined,
    name: string,
  ) =>
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  const newReplies: Array<{
    messageId: string
    receivedAtIso: string
    receivedAtMs: number
    inReplyTo: string | null
    references: string[]
  }> = []
  for (const m of messages) {
    if (knownMessageIds.has(m.id)) continue // 이미 저장된 회신
    const ts = Number(m.internalDate ?? 0)
    if (!ts || ts <= earliestSentAtMs) continue // 어떤 tm 보다도 이전이면 회신 아님
    const fromRaw = extractFromHeader(m.payload?.headers) ?? ''
    if (!fromRaw) continue
    const fromLower = fromRaw.toLowerCase()
    if (fromLower === userEmailLower) continue // 내가 보낸 followup/reply 추가본
    if (isBounceFrom(fromRaw)) continue // bounce 는 정상 회신 아님
    const headers = m.payload?.headers
    const inReplyTo = getH(headers, 'In-Reply-To')
    const referencesRaw = getH(headers, 'References') ?? ''
    // References 헤더는 공백 구분 RFC Message-ID 들. <>로 감싸진 토큰만 추출.
    const references = Array.from(referencesRaw.matchAll(/<[^<>\s]+>/g)).map((m) => m[0])
    newReplies.push({
      messageId: m.id,
      receivedAtIso: new Date(ts).toISOString(),
      receivedAtMs: ts,
      inReplyTo,
      references,
    })
  }
  newReplies.sort((a, b) => a.receivedAtMs - b.receivedAtMs)
  return newReplies
}

// 받은 회신의 본문에서 quote 부분을 떼어내 깨끗한 본문만 저장 → 재귀 회신 시 quote 폭발 방지.
// stripQuotedAndSignature 와 달리 시그니처는 보존 — 사용자가 회신한 사람의 부서/연락처 등을
// detail 모달에서 보고 싶어할 수 있음.
function stripQuoteForStorage(text: string): string {
  // 1) "On {date}, {name} wrote:" / "{date} ... 작성:" / "----- Original Message -----" /
  //    "From: ... Sent: ..." 같은 인용 헤더 이후를 자르기
  const replyHeaderPatterns = [
    /\n\s*On .+ wrote:[\s\S]*$/m,
    /\n\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[\s\S]+(작성|wrote|쓴 글|보낸 메일):[\s\S]*$/m,
    /\n\s*-+\s*Original Message\s*-+[\s\S]*$/im,
    /\n\s*From:.+\nSent:.+[\s\S]*$/im,
  ]
  let out = text
  for (const re of replyHeaderPatterns) out = out.replace(re, '')

  // 2) 인용된 라인 (> 로 시작) 제거 — 시그니처는 건드리지 않음
  out = out
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')

  return out.trim()
}

// "이름 <foo@bar.com>" 또는 "foo@bar.com" 파싱 → { name, email }
function parseFromAddress(raw: string | null): { email: string | null; name: string | null } {
  if (!raw) return { email: null, name: null }
  const m = raw.match(/^\s*(?:"?([^"<]+?)"?\s*)?<\s*([^>\s]+)\s*>\s*$/)
  if (m) {
    return { name: m[1]?.trim() || null, email: m[2].trim().toLowerCase() }
  }
  // angle bracket 없는 케이스
  const trimmed = raw.trim()
  if (/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    return { email: trimmed.toLowerCase(), name: null }
  }
  return { email: null, name: raw.slice(0, 200) }
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
// 반송 본문에서 가장 의미있는 한 줄 추출. mailer-daemon 메시지의 보일러플레이트를
// 건너뛰고 SMTP 코드 (550/553/554/5.x.x) 가 포함된 라인을 우선 픽업.
function extractBounceReason(text: string): string | null {
  if (!text) return null
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // 1차: 표준 SMTP 응답 코드 라인
  const smtpRe = /(?:5\d\.\d\.\d|5\d\d\b).+/
  for (const l of lines) {
    if (smtpRe.test(l) && l.length <= 240) return l
  }
  // 2차: "Address not found" / "user unknown" / "mailbox" / "delivery failed" 같은 키워드
  const keywords =
    /(?:address not found|user unknown|no such user|mailbox (?:does not exist|not found|unavailable|full)|delivery (?:has )?failed|message could not be delivered|recipient address rejected|undeliverable)/i
  for (const l of lines) {
    if (keywords.test(l) && l.length <= 240) return l
  }
  // 3차: 영문 "The response from the remote server was:" 다음 줄
  for (let i = 0; i < lines.length; i++) {
    if (/response from the remote server/i.test(lines[i]) && lines[i + 1]) {
      return lines[i + 1].slice(0, 240)
    }
  }
  return null
}

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
