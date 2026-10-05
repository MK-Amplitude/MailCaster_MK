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
import { decryptToken } from '../_shared/tokenCrypto.ts'
import { isCronAuthorized } from '../_shared/cronAuth.ts'

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
// pass1 후보 나이 상한 — 오래된 발송분이 큐를 무한히 키워 신규 캠페인 감지가 늦어지는 것 방지.
// (반송은 수일 내 도착, 이후 회신은 check-inbox 가 inbound 로 수집)
const REPLY_CHECK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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
  | 'unsubscribe'

const VALID_CATEGORIES = new Set<ReplyCategory>([
  'interested',
  'not_interested',
  'question',
  'out_of_office',
  'unclear',
  'unsubscribe',
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
  // pass2 전용 — 첫 답장 시각 (이후 메시지만 수신거부 재검사)
  replied_at?: string | null
  campaigns: CampaignJoin | CampaignJoin[] | null
}

interface CampaignJoin {
  user_id: string
  send_mode?: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!CRON_SECRET) return json({ error: 'CRON_SECRET not configured' }, 500)
  const auth = req.headers.get('Authorization') ?? ''
  if (!isCronAuthorized(auth, CRON_SECRET)) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const runStartedAt = Date.now()

  try {
    // ------------------------------------------------------------
    // 1) 큐에서 BATCH_SIZE 개 집어오기
    // ------------------------------------------------------------
    // partial index idx_recipients_reply_check 로 커버되는 쿼리.
    // campaigns!inner 로 user_id 조인 (토큰 공유 그룹핑용) + send_mode (bulk = 공유 thread).
    const maxAgeIso = new Date(runStartedAt - REPLY_CHECK_MAX_AGE_MS).toISOString()
    const { data: rowsRaw, error: qErr } = await supabase
      .schema('mailcaster')
      .from('recipients')
      .select('id, campaign_id, gmail_thread_id, sent_at, email, contact_id, campaigns!inner(user_id, send_mode)')
      .eq('status', 'sent')
      .not('gmail_thread_id', 'is', null)
      .eq('replied', false)
      .eq('bounced', false)
      .gte('sent_at', maxAgeIso)
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
    const sharedThreadOf = buildSharedThreadCheck(rows)

    // 같은 run 안에서 thread / DSN 재조회 방지 (bulk 는 수백 행이 thread 1개 공유).
    const threadCache: ThreadCache = new Map()
    const dsnCache: DsnCache = new Map()

    // 결과 버퍼 — 한 번에 몰아서 DB 반영.
    const noReplyIds: string[] = [] // last_reply_check_at 만 갱신
    // 토큰/프로필 문제로 조회 못 한 사용자 행 — 회전시켜 다른 사용자 큐를 막지 않게 함.
    const tokenSkipIds: string[] = []
    const repliedInfos: Array<{
      id: string
      repliedAtIso: string
      cid: string
      // 수신거부 등록 대상 — 답장 From 주소 (수신자 본인이면 r.email 과 동일)
      optOutEmail: string
      contactId: string | null
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
        // 토큰 없는 사용자 — 스킵하되 회전: 안 하면 이 사용자 행이 매 tick 같은 batch 를 점유해
        // 다른 사용자 답장/반송 감지가 전부 멈춤.
        console.warn('[check-replies] skip uid=', userId, 'no refresh_token')
        tokenSkipIds.push(...list.map((r) => r.id))
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
        // 회전 — 위와 같은 이유 (큐 맨 뒤로 보내고 다음 순환 때 재시도)
        tokenSkipIds.push(...list.map((r) => r.id))
        continue
      }

      // 3-2) 이 사용자의 수신자들 Gmail threads.get
      for (const r of list) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break userLoop

        try {
          const result = await detectReplyOrBounce(r, {
            accessToken,
            userId,
            userEmailLower: userEmail,
            shared: sharedThreadOf(r),
            threadCache,
            dsnCache,
            deadlineMs: runStartedAt + RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS,
          })
          processed++
          if (result?.kind === 'bounce') {
            bouncedInfos.push({
              id: r.id,
              bouncedAtIso: result.bouncedAtIso,
              cid: r.campaign_id,
              reason: result.reason.slice(0, 500),
              recipientEmail: r.email,
            })
            campaignIdsTouched.add(r.campaign_id)
          } else if (result?.kind === 'reply') {
            // 본문 조회 + 분류 예산이 없으면 이 행은 기록하지 않고 다음 tick 으로 이월
            // (회전 안 함 → 큐 맨 앞 유지). 'unclear' 로 저장해 버리면 replied=true 가 되어
            // 수신거부 답장이 영구히 누락됨.
            if (RUN_BUDGET_MS - (Date.now() - runStartedAt) <= CLASSIFY_BUDGET_MS) break userLoop
            let bodyText: string
            try {
              bodyText = await fetchReplyBody(accessToken, result.messageId)
            } catch (e) {
              // 본문 없이 기록하면 수신거부 검사 불가 → 회전 후 다음 순환에서 재시도
              gmailErrors++
              console.warn(
                '[check-replies] reply body fetch fail rid=',
                r.id,
                e instanceof Error ? e.message : e
              )
              noReplyIds.push(r.id)
              continue
            }
            // 명시적 수신거부 문구는 LLM 과 무관하게 결정적으로 판정 (키 미설정·실패에도 누락 방지).
            let category: ReplyCategory = 'unclear'
            if (hasExplicitOptOut(bodyText)) {
              category = 'unsubscribe'
            } else {
              try {
                category = await classifyReplyText(bodyText)
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
              optOutEmail: result.fromEmail,
              contactId: r.contact_id,
              category,
              meta: result.meta,
            })
            campaignIdsTouched.add(r.campaign_id)
          } else {
            noReplyIds.push(r.id)
          }
        } catch (e) {
          // 예산 소진 — 이 행은 손대지 않고 다음 tick 으로 (회전 안 함)
          if (e instanceof BudgetExceeded) break userLoop
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

    // 4-1b) 명시적 수신거부 의사('unsubscribe') → 자동 unsubscribes 등록.
    //  RPC record_reply_optout 이 캠페인에서 org/user 역추적 후 등록(트리거가 contacts 동기화).
    //  ON CONFLICT DO NOTHING 으로 중복 안전. 실패해도 답장 기록 자체는 보존.
    const optOuts = repliedInfos.filter((i) => i.category === 'unsubscribe')
    for (const o of optOuts) {
      const { data: didOptOut, error: optErr } = await supabase
        .schema('mailcaster')
        .rpc('record_reply_optout', {
          p_email: o.optOutEmail,
          p_source_campaign_id: o.cid,
          p_reason: '답장에서 수신거부 의사 자동 감지',
        })
      if (optErr) console.warn('[check-replies] optout fail', o.optOutEmail, optErr.message)
      else if (didOptOut) console.log('[check-replies] auto-unsubscribed', o.optOutEmail)
    }

    // 4-1c) 답장한 contact 의 진행 중 시퀀스 자동 정지 (069 — 캠페인 후속 시퀀스 안전장치).
    //  check-inbox 도 새 inbound 시 정지하지만, 캠페인 스레드 답장이 inbox 폴링보다 먼저
    //  여기서 감지될 수 있어 contact 기준으로 즉시 정지한다. (idempotent — active 만 영향)
    const orgIdByCid = new Map<string, string | null>()
    async function orgIdForCampaign(cid: string): Promise<string | null> {
      const cached = orgIdByCid.get(cid)
      if (cached !== undefined) return cached
      const { data } = await supabase
        .schema('mailcaster')
        .from('campaigns')
        .select('org_id')
        .eq('id', cid)
        .maybeSingle()
      const orgId = (data?.org_id as string | undefined) ?? null
      orgIdByCid.set(cid, orgId)
      return orgId
    }
    for (const info of repliedInfos) {
      if (!info.contactId) continue
      const orgId = await orgIdForCampaign(info.cid)
      if (!orgId) continue
      const { error: stopErr } = await supabase
        .schema('mailcaster')
        .rpc('stop_active_enrollments_for_contact', {
          p_org_id: orgId,
          p_contact_id: info.contactId,
          p_reason: 'replied',
        })
      if (stopErr) console.warn('[check-replies] seq stop fail', info.contactId, stopErr.message)
    }

    // 4-2) 답장 없음 + 토큰 문제 사용자 — 한 번에 rotate
    const rotateIds = [...noReplyIds, ...tokenSkipIds]
    if (rotateIds.length > 0) {
      const { error } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ last_reply_check_at: nowIso })
        .in('id', rotateIds)
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
          // status 도 'bounced' 로 — analytics RPC (066) 와 useOutboundFeed 가
          // status='bounced' 를 조회하는데 플래그만 세우면 피드에 "발송됨" 으로 표시됨.
          status: 'bounced',
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
      // org 식별은 위에서 만든 orgIdForCampaign 캐시 재사용 (같은 캠페인 반복 조회 방지)
      const orgId = await orgIdForCampaign(b.cid)
      if (!orgId) continue

      // 기존 bounce_count 가져와서 +1
      // ilike 는 대소문자 무시용 — `_`/`%` 가 와일드카드로 다른 주소까지 잡지 않게 escape 하고,
      // PostgREST 의 `*` 와일드카드까지 막기 위해 결과를 정확 일치로 한 번 더 거른다.
      const bounceEmailLower = normEmail(b.recipientEmail)
      if (!bounceEmailLower) continue
      const { data: cRowsRaw } = await supabase
        .schema('mailcaster')
        .from('contacts')
        .select('id, email, bounce_count')
        .eq('org_id', orgId)
        .ilike('email', escapeLikePattern(bounceEmailLower))
      const cRows = (cRowsRaw ?? []).filter(
        (c: { email: string | null }) => normEmail(c.email) === bounceEmailLower,
      )
      if (cRows.length === 0) continue
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
    // + 첫 답장 이후 수신자 본인이 보낸 새 메시지의 명시적 수신거부 검사
    //   (pass1 은 첫 답장만 분류 — "자료 부탁" 후 "그만 보내주세요" 가 누락되던 문제).
    // ------------------------------------------------------------
    let pass2OptOuts = 0
    if (Date.now() - runStartedAt < RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) {
      const cooldownIso = new Date(Date.now() - THREAD_RECHECK_COOLDOWN_MS).toISOString()
      const { data: pass2Raw } = await supabase
        .schema('mailcaster')
        .from('recipients')
        .select('id, campaign_id, gmail_thread_id, sent_at, email, contact_id, replied_at, campaigns!inner(user_id, send_mode)')
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

      const rotatePass2 = async (ids: string[]) => {
        if (ids.length === 0) return
        await supabase
          .schema('mailcaster')
          .from('recipients')
          .update({ last_reply_check_at: nowIso })
          .in('id', ids)
      }

      pass2Loop: for (const [userId, list] of pass2ByUser) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break
        const { data: profile } = await supabase
          .schema('mailcaster')
          .from('profiles')
          .select('email, google_refresh_token')
          .eq('id', userId)
          .single()
        if (!profile?.google_refresh_token || !profile?.email) {
          // 토큰 없는 사용자 행이 pass2 batch 를 점유하지 않도록 회전
          await rotatePass2(list.map((r) => r.id))
          continue
        }
        let accessToken: string
        try {
          accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
        } catch {
          await rotatePass2(list.map((r) => r.id))
          continue
        }
        const userEmailLower = (profile.email as string).toLowerCase()

        for (const r of list) {
          if (Date.now() - runStartedAt > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break pass2Loop
          try {
            const analysis = await getThreadCached(
              threadCache,
              userId,
              accessToken,
              r.gmail_thread_id,
              userEmailLower,
            )
            if (!analysis) {
              // thread 삭제됨 — last_reply_check_at 만 갱신해 큐 회전
              await rotatePass2([r.id])
              continue
            }

            // 첫 답장(pass1 에서 분류됨) 이후 수신자 본인이 보낸 메시지만 — 최근 3통.
            // (공유 thread 의 타인 메시지는 무시. last_thread_message_at 기준으로 하면 pass1 시점에
            //  이미 와 있던 두 번째 메시지가 영영 검사되지 않음)
            const recipientLower = normEmail(r.email)
            const watermarkMs = Math.max(
              r.replied_at ? Date.parse(r.replied_at) || 0 : 0,
              r.sent_at ? Date.parse(r.sent_at) || 0 : 0,
            )
            const newFromRecipient = analysis.messages
              .filter((m) => m.ms > watermarkMs && !!recipientLower && m.fromEmail === recipientLower)
              .filter((m) => !isBounceFrom(m.fromRaw))
              .slice(-3)
            let optOutDetected = false
            let scanIncomplete = false
            for (const m of newFromRecipient) {
              if (RUN_BUDGET_MS - (Date.now() - runStartedAt) <= REPLY_META_BUDGET_MS + GMAIL_CALL_BUDGET_MS) {
                // 예산 부족 — 이 행은 손대지 않고 다음 tick 에 재검사
                break pass2Loop
              }
              try {
                const body = await fetchReplyBody(accessToken, m.id)
                if (hasExplicitOptOut(body)) {
                  optOutDetected = true
                  break
                }
              } catch {
                scanIncomplete = true
              }
            }

            if (optOutDetected) {
              const { data: didOptOut, error: optErr } = await supabase
                .schema('mailcaster')
                .rpc('record_reply_optout', {
                  p_email: r.email,
                  p_source_campaign_id: r.campaign_id,
                  p_reason: '답장에서 수신거부 의사 자동 감지',
                })
              if (optErr) {
                console.warn('[check-replies pass2] optout fail', r.email, optErr.message)
                scanIncomplete = true
              } else if (didOptOut) {
                pass2OptOuts++
                await supabase
                  .schema('mailcaster')
                  .from('recipients')
                  .update({ reply_category: 'unsubscribe' })
                  .eq('id', r.id)
              }
            }

            if (scanIncomplete) {
              // 본문 조회/등록 실패 — 메타 갱신 없이 회전 (다음 방문 때 같은 메시지 재검사)
              await rotatePass2([r.id])
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
            await rotatePass2([r.id])
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
    let pass3BouncesFound = 0
    let pass3OptOuts = 0
    if (Date.now() - runStartedAt < RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) {
      const pass3CooldownIso = new Date(Date.now() - THREAD_MSG_RECHECK_COOLDOWN_MS).toISOString()
      const { data: pass3Raw } = await supabase
        .schema('mailcaster')
        .from('thread_messages')
        .select('id, org_id, user_id, gmail_thread_id, gmail_message_id, rfc_message_id, in_reply_to_message_id, campaign_id, sent_at, bounced, to_email')
        .eq('status', 'sent')
        .eq('bounced', false) // bounce 된 tm 은 다시 폴링 안 함 — Gmail quota 절감
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
        bounced: boolean
        to_email: string | null
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
          // 토큰 없음 — 회전 (안 하면 이 사용자 행이 매 tick pass3 batch 를 점유해 다른 사용자 회신 폴링이 멈춤)
          await supabase
            .schema('mailcaster')
            .from('thread_messages')
            .update({ last_reply_check_at: nowIso })
            .in('id', group.map((r) => r.id))
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

            // bounce 분기 — 정상 회신이 아닌 bounce 메시지 → thread_messages.bounced=true 마킹
            if (nr.isBounce) {
              const refs = [nr.inReplyTo, ...nr.references].filter(
                (v): v is string => !!v,
              )
              const bounceTm = matchTargetTmInThread(group, refs, nr.receivedAtMs)
              if (!bounceTm || bounceTm.bounced) continue
              // 영구 실패(5.x.x / Action: failed) 이면서 이 tm 수신 주소에 대한 DSN 일 때만 반송.
              // 지연(Delay / 4.x.x) 통지나 판정 불가 메일은 무시 — 조회 실패 시에도 마킹하지 않음.
              let dsn: DsnInfo
              try {
                dsn = await getDsnCached(dsnCache, userId, auth.token, nr.messageId, Number.MAX_SAFE_INTEGER)
              } catch (e) {
                console.warn(
                  '[check-replies pass3] dsn fetch fail mid=',
                  nr.messageId,
                  e instanceof Error ? e.message : e,
                )
                continue
              }
              const verdict = dsnVerdictFor(dsn, normEmail(bounceTm.to_email), false)
              if (!verdict.permanent) continue
              // bounce 사유 — raw From 헤더 대신 친화 fallback
              const fromParsedForBounce = parseFromAddress(nr.fromRaw)
              const fromLabel =
                fromParsedForBounce.email ?? fromParsedForBounce.name ?? '메일 시스템'
              const bounceReason = verdict.reason ?? `수신 거부 (${fromLabel})`
              const { error: bErr } = await supabase
                .schema('mailcaster')
                .from('thread_messages')
                .update({
                  bounced: true,
                  bounced_at: nr.receivedAtIso,
                  bounce_reason: bounceReason.slice(0, 500),
                })
                .eq('id', bounceTm.id)
                .eq('bounced', false) // race-safe: 이미 마킹돼 있으면 no-op
              if (bErr) {
                console.warn(
                  '[check-replies pass3] bounce update fail tmid=',
                  bounceTm.id,
                  bErr.message,
                )
              } else {
                pass3BouncesFound++
              }
              continue // bounce 는 record_thread_reply 호출 X
            }

            // 정상 reply 분기 — matchTargetTmInThread 사용 (bounce 와 동일 우선순위)
            const refs = [nr.inReplyTo, ...nr.references].filter(
              (v): v is string => !!v,
            )
            const targetTm = matchTargetTmInThread(group, refs, nr.receivedAtMs)
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

              // 명시적 수신거부 — 회신 보낸 사람 본인 주소만 등록 (트리거가 contacts 동기화 → 시퀀스 발송 가드가 정지)
              if (
                meta &&
                fromParsed.email &&
                fromParsed.email !== auth.emailLower &&
                hasExplicitOptOut(meta.bodyText)
              ) {
                const { data: didOptOut, error: optErr } = await supabase
                  .schema('mailcaster')
                  .rpc('record_thread_reply_optout', {
                    p_org_id: targetTm.org_id,
                    p_user_id: targetTm.user_id,
                    p_email: fromParsed.email,
                    p_source_campaign_id: targetTm.campaign_id,
                    p_reason: '회신에서 수신거부 의사 자동 감지',
                  })
                if (optErr) {
                  console.warn('[check-replies pass3] optout fail', fromParsed.email, optErr.message)
                } else if (didOptOut) {
                  pass3OptOuts++
                  console.log('[check-replies pass3] auto-unsubscribed', fromParsed.email)
                }
              }
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
      pass3_bounces_found: pass3BouncesFound,
      pass3_optouts: pass3OptOuts,
      pass2_optouts: pass2OptOuts,
      token_skipped: tokenSkipIds.length,
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
// Gmail threads.get + 답장/반송 판정
// ============================================================
//
// 답장 판정 기준 (행 = 수신자 1명):
//   1) internalDate > r.sent_at           (내 발송 이후 메시지)
//   2) From 주소 == 이 수신자 주소          (수신자 본인이 보낸 것)
//      — bulk 발송은 수백 명이 thread 1개를 공유하므로, 한 명의 답장/수신거부가
//        모든 행에 귀속되면 안 됨.
//   3) 단독 thread(개별 발송) 에 한해, 본인 답장이 없으면 외부(비내부 도메인) 발신자의
//      답장도 답장으로 인정 (별칭 주소·대리 회신). 이때 수신거부는 그 발신자 주소로만 등록.
//
// 반송 판정: mailer-daemon/postmaster 메일의 DSN 을 파싱해
//   영구 실패(Action: failed / Status 5.x.x) 이면서 실패 주소 = 이 수신자일 때만.
//   지연(Delay / 4.x.x) 통지는 반송 아님. 공유 thread 에서 실패 주소를 특정 못 하면 아무에게도 귀속 안 함.
// ============================================================
interface ThreadMeta {
  lastMessageAtIso: string
  lastMessageFromMe: boolean
  messageCount: number
}

interface ThreadMsg {
  id: string
  ms: number
  fromRaw: string
  // From 의 주소 부분 (소문자)
  fromEmail: string
}

interface ThreadData {
  // internalDate 오름차순
  messages: ThreadMsg[]
  meta: ThreadMeta
}

type ThreadCache = Map<string, Promise<ThreadData | null>>
type DsnCache = Map<string, Promise<DsnInfo>>

// 예산 소진 신호 — 호출자는 해당 행을 회전하지 않고 다음 tick 으로 넘긴다.
class BudgetExceeded extends Error {
  constructor() {
    super('run budget exceeded')
  }
}

// 발송 후 thread 에 들어온 메시지의 From 헤더가 이 패턴이면 반송 후보 (DSN 파싱으로 최종 판정).
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

// Gmail 조회용 fetch — 10초 타임아웃. sendGmail 과 달리 조회 계열엔 타임아웃이 없어
// 한 thread 가 hang 하면 run 전체가 죽고, 결과가 메모리에만 있어 tick 전체가 유실되던
// 문제 방지 (같은 150건을 다음 tick 이 다시 조회 — Gmail 쿼터 낭비).
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`Gmail API 호출 타임아웃 (${Math.round(timeoutMs / 1000)}초 초과)`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function fetchThreadAnalysis(
  accessToken: string,
  threadId: string,
  userEmailLower: string
): Promise<ThreadData | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date`
  const res = await fetchWithTimeout(url, {
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
  const raw = thread.messages ?? []
  if (raw.length === 0) return null

  // 가장 늦은 메시지 — 마지막 활동 시각 + 발신자
  let lastMs = 0
  let lastFromMe = false
  const messages: ThreadMsg[] = []
  for (const m of raw) {
    const ts = Number(m.internalDate ?? 0)
    if (!ts) continue
    const fromRaw = extractFromHeader(m.payload?.headers) ?? ''
    const fromEmail = normEmail(fromRaw)
    if (ts > lastMs) {
      lastMs = ts
      lastFromMe = fromEmail === userEmailLower
    }
    messages.push({ id: m.id, ms: ts, fromRaw, fromEmail })
  }
  messages.sort((a, b) => a.ms - b.ms)

  return {
    messages,
    meta: {
      lastMessageAtIso: lastMs > 0 ? new Date(lastMs).toISOString() : new Date().toISOString(),
      lastMessageFromMe: lastFromMe,
      messageCount: raw.length,
    },
  }
}

function getThreadCached(
  cache: ThreadCache,
  userId: string,
  accessToken: string,
  threadId: string,
  userEmailLower: string,
): Promise<ThreadData | null> {
  const key = `${userId}|${threadId}`
  let p = cache.get(key)
  if (!p) {
    p = fetchThreadAnalysis(accessToken, threadId, userEmailLower)
    cache.set(key, p)
  }
  return p
}

interface DetectCtx {
  accessToken: string
  userId: string
  userEmailLower: string
  // 여러 수신자 행이 이 thread 를 공유하는가 (bulk 발송)
  shared: boolean
  threadCache: ThreadCache
  dsnCache: DsnCache
  // 새 DSN 조회를 시작해도 되는 마지막 시각 (epoch ms)
  deadlineMs: number
}

// 답장 또는 반송 감지 — 둘 다 없으면 null. 둘 다 있으면 반송 우선 (먼저 보낸 메일이 반송된 경우).
async function detectReplyOrBounce(
  r: Row,
  ctx: DetectCtx,
): Promise<
  | {
      kind: 'reply'
      repliedAtIso: string
      messageId: string
      // 답장 From 주소 (소문자) — 수신거부 등록 대상
      fromEmail: string
      meta: ThreadMeta
    }
  | {
      kind: 'bounce'
      bouncedAtIso: string
      messageId: string
      reason: string
      meta: ThreadMeta
    }
  | null
> {
  const thread = await getThreadCached(
    ctx.threadCache,
    ctx.userId,
    ctx.accessToken,
    r.gmail_thread_id,
    ctx.userEmailLower,
  )
  if (!thread) return null
  const sentAtMs = r.sent_at ? Date.parse(r.sent_at) : 0
  const recipientLower = normEmail(r.email)
  const others = thread.messages.filter(
    (m) => m.ms > sentAtMs && m.fromEmail !== ctx.userEmailLower,
  )

  for (const m of others) {
    if (!isBounceFrom(m.fromRaw)) continue
    const dsn = await getDsnCached(ctx.dsnCache, ctx.userId, ctx.accessToken, m.id, ctx.deadlineMs)
    const verdict = dsnVerdictFor(dsn, recipientLower, ctx.shared)
    if (verdict.permanent) {
      return {
        kind: 'bounce',
        bouncedAtIso: new Date(m.ms).toISOString(),
        messageId: m.id,
        reason: verdict.reason ?? `Bounced from ${m.fromRaw}`,
        meta: thread.meta,
      }
    }
  }

  const candidates = others.filter((m) => !isBounceFrom(m.fromRaw) && !!m.fromEmail)
  let reply = recipientLower
    ? candidates.find((m) => m.fromEmail === recipientLower)
    : undefined
  if (!reply && !ctx.shared) {
    reply = candidates.find(
      (m) => !isInternalSender(m.fromEmail, ctx.userEmailLower, recipientLower),
    )
  }
  if (!reply) return null
  return {
    kind: 'reply',
    repliedAtIso: new Date(reply.ms).toISOString(),
    messageId: reply.id,
    fromEmail: reply.fromEmail,
    meta: thread.meta,
  }
}

// 이 배치에서 행이 공유 thread 에 속하는지 — send_mode='bulk' 이거나 같은 thread 행이 둘 이상.
function buildSharedThreadCheck(rows: Row[]): (r: Row) => boolean {
  const countByThread = new Map<string, number>()
  for (const r of rows) {
    countByThread.set(r.gmail_thread_id, (countByThread.get(r.gmail_thread_id) ?? 0) + 1)
  }
  return (r: Row) =>
    sendModeOf(r) === 'bulk' || (countByThread.get(r.gmail_thread_id) ?? 0) > 1
}

// 개인 메일 도메인 — 같은 도메인이어도 "사내 동료" 로 볼 수 없음
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com',
  'nate.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
])

// 발송자와 같은 회사 도메인의 발신자 (CC 된 내부 동료의 reply-all 등) — 수신자 답장으로 보지 않음.
function isInternalSender(fromLower: string, userEmailLower: string, recipientLower: string): boolean {
  const d = domainOf(fromLower)
  const myDomain = domainOf(userEmailLower)
  if (!d || !myDomain || d !== myDomain) return false
  if (FREE_MAIL_DOMAINS.has(myDomain)) return false
  // 수신자 자체가 같은 회사면 (사내 발송) 도메인으로 구분 불가 — 내부로 보지 않음
  return domainOf(recipientLower) !== myDomain
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1) : ''
}

// ============================================================
// DSN (Delivery Status Notification) 파싱
// ============================================================
interface DsnRecipient {
  action: string
  status: string
  diagnostic: string
}

interface DsnInfo {
  // message/delivery-status 의 수신자별 블록 (Final-Recipient / Original-Recipient 주소 → 결과)
  recipients: Map<string, DsnRecipient>
  // X-Failed-Recipients 헤더 (Gmail 등)
  failedRecipients: Set<string>
  // 메시지 전체 수준 판정 — 수신자별 정보가 없을 때만 사용
  kind: 'failure' | 'delay' | 'unknown'
  humanReason: string | null
}

const DSN_DELAY_SUBJECT_RE =
  /\(delay\)|delayed|delay notification|not (?:yet )?been delivered|still (?:being )?(?:retried|trying)|will (?:keep )?retry|지연/i
const DSN_FAILURE_SUBJECT_RE =
  /\(failure\)|undeliver|returned mail|returned to sender|delivery (?:has )?fail|failure notice|could not be delivered|mail delivery failed|발송 실패|전송 실패|배달 실패|반송/i
const DSN_PERMANENT_BODY_RE =
  /\b5\.\d{1,3}\.\d{1,3}\b|\b55[0-4][\s-]|address not found|user unknown|no such user|mailbox (?:does not exist|not found|unavailable)|recipient address rejected/i
const DSN_TEMP_BODY_RE = /\b4\.\d{1,3}\.\d{1,3}\b|will (?:keep )?retry|delayed|temporar/i

function getDsnCached(
  cache: DsnCache,
  userId: string,
  accessToken: string,
  messageId: string,
  deadlineMs: number,
): Promise<DsnInfo> {
  const key = `${userId}|${messageId}`
  let p = cache.get(key)
  if (!p) {
    if (Date.now() > deadlineMs) throw new BudgetExceeded()
    p = fetchDsn(accessToken, messageId)
    // 실패는 캐시하지 않음 — 다른 행/다음 tick 이 재시도
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

async function fetchDsn(accessToken: string, messageId: string): Promise<DsnInfo> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    throw new Error(`Gmail messages.get ${res.status}`)
  }
  const msg = (await res.json()) as {
    payload?: GmailPart & { headers?: Array<{ name: string; value: string }> }
  }
  return parseDsn(msg.payload)
}

function parseDsn(payload?: GmailPart & { headers?: Array<{ name: string; value: string }> }): DsnInfo {
  const headers = payload?.headers ?? []
  const getH = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  const subject = getH('Subject')
  const failedRecipients = new Set(
    Array.from(getH('X-Failed-Recipients').matchAll(/[^\s,;<>"]+@[^\s,;<>"]+/g)).map((m) =>
      normEmail(m[0]),
    ),
  )

  const recipients = new Map<string, DsnRecipient>()
  const statusTexts: string[] = []
  const walk = (part?: GmailPart) => {
    if (!part) return
    if (part.mimeType?.toLowerCase() === 'message/delivery-status' && part.body?.data) {
      statusTexts.push(decodeBase64Url(part.body.data))
    }
    for (const p of part.parts ?? []) walk(p)
  }
  walk(payload)
  for (const t of statusTexts) parseDeliveryStatus(t, recipients)

  const human = extractTextBody(payload) ?? ''
  let kind: DsnInfo['kind'] = 'unknown'
  if (DSN_DELAY_SUBJECT_RE.test(subject)) kind = 'delay'
  else if (DSN_FAILURE_SUBJECT_RE.test(subject) || failedRecipients.size > 0) kind = 'failure'
  else if (DSN_PERMANENT_BODY_RE.test(human)) kind = 'failure'
  else if (DSN_TEMP_BODY_RE.test(human)) kind = 'delay'

  return { recipients, failedRecipients, kind, humanReason: extractBounceReason(human) }
}

// RFC 3464 message/delivery-status — 빈 줄로 구분된 블록, 첫 블록은 메시지 단위, 이후 수신자 단위.
function parseDeliveryStatus(text: string, out: Map<string, DsnRecipient>) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ')
  for (const block of unfolded.split(/\n\s*\n/)) {
    const fields = new Map<string, string>()
    for (const line of block.split('\n')) {
      const m = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line)
      if (m) fields.set(m[1].toLowerCase(), m[2].trim())
    }
    const addrs = [fields.get('final-recipient'), fields.get('original-recipient')]
      .map((v) => (v ? normEmail(v.includes(';') ? v.slice(v.indexOf(';') + 1) : v) : ''))
      .filter((v) => !!v)
    if (addrs.length === 0) continue
    const entry: DsnRecipient = {
      action: (fields.get('action') ?? '').toLowerCase(),
      status: fields.get('status') ?? '',
      diagnostic: fields.get('diagnostic-code') ?? '',
    }
    for (const a of addrs) out.set(a, entry)
  }
}

// 이 주소에 대한 영구 실패 DSN 인가.
function dsnVerdictFor(
  dsn: DsnInfo,
  emailLower: string,
  shared: boolean,
): { permanent: boolean; reason: string | null } {
  if (!emailLower) return { permanent: false, reason: null }
  const entry = dsn.recipients.get(emailLower)
  if (entry) {
    // Action: failed 는 4.x.x(재시도 만료) 여도 최종 실패. delayed/delivered/relayed 는 반송 아님.
    const permanent = entry.action === 'failed' || /^5\./.test(entry.status)
    const reason =
      (entry.diagnostic && entry.diagnostic.slice(0, 240)) ||
      dsn.humanReason ||
      (entry.status ? `Status ${entry.status}` : null)
    return { permanent, reason }
  }
  if (dsn.failedRecipients.size > 0) {
    return {
      permanent: dsn.failedRecipients.has(emailLower) && dsn.kind !== 'delay',
      reason: dsn.humanReason,
    }
  }
  // 다른 주소(CC 등) 에 대한 DSN
  if (dsn.recipients.size > 0) return { permanent: false, reason: null }
  // 실패 주소를 특정할 수 없음 — 공유 thread 면 아무에게도 귀속하지 않음
  if (shared) return { permanent: false, reason: null }
  return { permanent: dsn.kind === 'failure', reason: dsn.humanReason }
}

// ============================================================
// 명시적 수신거부 문구 (결정적 검사)
// ============================================================
// LLM 분류가 예산 부족·실패·키 미설정으로 skip 돼도 수신거부가 누락되지 않게 하는 안전망.
// 인용·서명을 잘라낸 "새로 쓴 부분" 의 앞부분만 검사 — 인용된 우리 원문의 수신거부 안내 문구 오탐 방지.
const OPT_OUT_PATTERNS: RegExp[] = [
  /수신\s*거부/,
  /수신\s*(?:을|를)?\s*(?:원하지|원치)\s*않/,
  /그만\s*(?:좀\s*)?(?:보내|연락)/,
  // "보내지 마시고 링크로…" 같은 지시문 제외 — 수식어(더 이상/앞으로/다시) 가 있거나 문장이 끝날 때만
  /(?:메일|이메일|더\s*이상|앞으로|다시는?)[^\n.]{0,15}(?:보내지|연락\s*(?:하지|주지))\s*(?:말아|마)/,
  /(?:보내지|연락\s*(?:하지|주지))\s*(?:말아\s*주|마)(?:세요|십시오|십시요|요)?\s*(?:[.!~]|$)/m,
  /(?:메일|이메일|연락|발송)\s*(?:을|를|은|는)?\s*(?:그만|중단|중지)\s*(?:해|하여|좀|바랍|부탁|요청)/,
  /광고\s*(?:메일)?\s*사절/,
  /\bunsubscribe\b/i,
  /\bremove\s+me\b/i,
  /\btake\s+me\s+off\b/i,
  /\bstop\s+(?:e-?mailing|sending|contacting)\b/i,
  /\bopt[\s-]?out\b/i,
  /\b(?:do\s+not|don'?t)\s+(?:e-?mail|contact)\s+me\b/i,
]

// 인용 시작 표지 — 처음 등장하는 위치에서 자른다 (HTML→텍스트 변환으로 줄바꿈이 사라진 본문도 처리).
const QUOTE_START_PATTERNS: RegExp[] = [
  /^[ \t]*>/m,
  /\bOn\b[\s\S]{0,300}?\bwrote:/,
  /\bwrote:/i,
  /님이\s*작성/,
  /작성:/,
  /-{2,}\s*(?:Original Message|원본 메시지|Forwarded message|전달된 메시지)\s*-{2,}/i,
  /(?:^|\s)(?:From|보낸\s*사람)\s*:[\s\S]{0,300}?(?:Sent|Date|보낸\s*날짜|날짜)\s*:/i,
]
const OPT_OUT_SCAN_MAX_CHARS = 1500

function extractNewReplyText(text: string): string {
  let cut = text.length
  for (const re of QUOTE_START_PATTERNS) {
    const m = re.exec(text)
    if (m && m.index < cut) cut = m.index
  }
  let out = text.slice(0, cut)
  // 시그니처 구분자 (-- 단독 라인) 이후 제거
  out = out.replace(/\n--\s*\n[\s\S]*$/m, '')
  return out.slice(0, OPT_OUT_SCAN_MAX_CHARS)
}

// 우리 메일 footer 의 수신거부 안내 — send-scheduled-campaigns / useSendCampaign 의
// unsubscribeFooterHtml 과 같은 문구:
//   "본 메일의 수신을 원하지 않으시면 <a>수신거부</a>를 눌러주세요."            (개별 발송 + 링크)
//   "본 메일의 수신을 원하지 않으시면 이 메일에 '수신거부'라고 회신해 주세요."  (일괄 발송)
// 인용 표지를 못 찾아 인용된 원문이 스캔 범위에 들어와도 이 문구로는 수신거부가 감지되지 않게
// 패턴 검사 전에 지운다. 클라이언트가 줄바꿈/'>' 인용 표시를 끼워 넣어도 맞도록 [\s>]* 허용.
const OWN_FOOTER_PATTERNS: RegExp[] = [
  // 문장 전체 — "주세요/주십시오" 로 끝나는 첫 지점까지 (실제 문구 ~45자, 여유 120자)
  /본[\s>]*메일의[\s>]*수신을[\s>]*원하지[\s>]*않으시면[\s\S]{0,120}?(?:주세요|주십시오)[.!]?/g,
  // 끝맺음을 못 찾으면 (잘림/변형) 그 줄 끝까지
  /본[\s>]*메일의[\s>]*수신을[\s>]*원하지[\s>]*않으시면[^\n]{0,120}/g,
  // 문장 앞부분이 잘리거나 줄이 나뉜 나머지 조각
  /['"‘’“”]?수신[\s>]*거부['"‘’“”]?[\s>]*(?:이)?라고[\s>]*회신해[\s>]*(?:주세요|주십시오)[.!]?/g,
  /수신[\s>]*거부[\s>]*(?:<[^>\s]*>|\[[^\]\s]*\]|\(\s*https?:[^)\s]*\))?[\s>]*를[\s>]*눌러[\s>]*(?:주세요|주십시오)[.!]?/g,
]
// footer 링크(…/unsubscribe?t=…) 가 텍스트 변환 본문에 URL 로 남으면 /\bunsubscribe\b/ 에 걸린다.
// 사용자가 URL 안에 수신거부 의사를 쓰지는 않으므로 URL 은 통째로 제거.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()]+/gi

function stripOwnFooter(text: string): string {
  let out = text.replace(URL_PATTERN, ' ')
  for (const re of OWN_FOOTER_PATTERNS) out = out.replace(re, ' ')
  return out
}

function hasExplicitOptOut(bodyText: string): boolean {
  if (!bodyText) return false
  const fresh = extractNewReplyText(stripOwnFooter(bodyText))
  return OPT_OUT_PATTERNS.some((p) => p.test(fresh))
}

// ============================================================
// OpenAI 분류
// ============================================================
// 1) (호출자가 Gmail messages.get 으로 가져온) 답장 본문 (text/plain 우선, fallback text/html stripped)
// 2) 인용 부분(>로 시작하는 라인) 과 시그니처 영역을 휴리스틱으로 제거 → 본문만 남김
// 3) OpenAI 로 6분류 — 짧은 system prompt, 50~100 token 응답.
async function classifyReplyText(text: string): Promise<ReplyCategory> {
  if (!OPENAI_API_KEY) return 'unclear'

  // 인용 제거가 실패해도 우리 footer 의 수신거부 안내 문구로 'unsubscribe' 분류되지 않게 먼저 제거
  const trimmed = stripQuotedAndSignature(stripOwnFooter(text)).slice(0, REPLY_BODY_MAX_CHARS)
  if (!trimmed.trim()) return 'unclear'

  const systemPrompt = `당신은 한국어 B2B 영업 답장의 톤을 6가지로 분류합니다.
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
- unsubscribe     : 명시적으로 "메일 발송을 중단/수신거부" 를 요청.
                    예) "수신거부", "메일 그만 보내주세요", "더 이상 연락하지 마세요",
                         "발송 중단해주세요", "unsubscribe", "remove me", "stop emailing".
                    주의: 발송 중단 요청이 명확할 때만. 단순 거절("관심 없습니다")은
                    not_interested 이지 unsubscribe 가 아님. 수신거부 링크 문의·오류
                    질문은 question 또는 unclear (수신거부 요청 아님).
- unclear         : 위에 안 맞거나 톤이 모호 — 단순 회신·인사·"알겠습니다" 류 포함

규칙:
1) 반드시 위 6개 중 하나.
2) interested 는 보수적으로 — 약속·동의·구체적 액션이 명확할 때만.
3) unsubscribe 는 발송 중단 요청이 명시적일 때만 (자동 수신거부 처리됨).
4) JSON 외 다른 출력 금지.`

  const userPrompt = `답장 본문:\n"""\n${trimmed}\n"""\n\n위 6개 중 하나로 분류:`

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
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } })
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
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } })
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

// pass3 의 타겟 tm 결정 헬퍼. bounce/reply 분기 모두 같은 우선순위 사용.
//   1) RFC Message-ID 매칭 (A 가 우리 메시지에 응답한 In-Reply-To 헤더)
//   2) in_reply_to_message_id 매칭 (보조 — 우리 thread_message 가 응답한 원본)
//   3) chronological fallback (receivedAt 직전 sent_at 의 tm)
function matchTargetTmInThread<
  T extends {
    rfc_message_id: string | null
    in_reply_to_message_id: string | null
    sent_at: string | null
  },
>(group: T[], references: string[], receivedAtMs: number): T | null {
  // 1순위 — rfc_message_id 매칭
  for (const ref of references) {
    const matched = group.find((g) => g.rfc_message_id === ref)
    if (matched) return matched
  }
  // 2순위 — in_reply_to_message_id 매칭
  for (const ref of references) {
    const matched = group.find((g) => g.in_reply_to_message_id === ref)
    if (matched) return matched
  }
  // 3순위 — receivedAt 직전 sent_at 의 tm
  if (group.length === 0) return null
  const sortedBySentAt = [...group].sort((a, b) => {
    const ta = a.sent_at ? Date.parse(a.sent_at) : 0
    const tb = b.sent_at ? Date.parse(b.sent_at) : 0
    return tb - ta
  })
  return (
    sortedBySentAt.find((g) => {
      const sentMs = g.sent_at ? Date.parse(g.sent_at) : Number.MAX_SAFE_INTEGER
      return sentMs <= receivedAtMs
    }) ?? sortedBySentAt[sortedBySentAt.length - 1]
  )
}

// pass3 전용 — earliestThreadMessageSentAtMs 이후 + 타인 발신 + knownMessageIds 에 없는 메시지 전부.
// In-Reply-To / References 헤더도 함께 가져옴 — 다중 회신을 정확한 tm 에 매핑하기 위함.
// bounce 는 별도 isBounce=true 로 마킹해서 caller 가 분기 처리.
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
  isBounce: boolean
  fromRaw: string
}>> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=In-Reply-To&metadataHeaders=References`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } })
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
    isBounce: boolean
    fromRaw: string
  }> = []
  for (const m of messages) {
    if (knownMessageIds.has(m.id)) continue // 이미 저장된 회신
    const ts = Number(m.internalDate ?? 0)
    if (!ts || ts <= earliestSentAtMs) continue // 어떤 tm 보다도 이전이면 회신 아님
    const fromRaw = extractFromHeader(m.payload?.headers) ?? ''
    if (!fromRaw) continue
    const fromLower = fromRaw.toLowerCase()
    if (fromLower === userEmailLower) continue // 내가 보낸 followup/reply 추가본
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
      isBounce: isBounceFrom(fromRaw),
      fromRaw,
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

function sendModeOf(r: Row): string | null {
  const c = r.campaigns
  if (!c) return null
  if (Array.isArray(c)) return c[0]?.send_mode ?? null
  return c.send_mode ?? null
}

// "Name <a@b.com>" / "<a@b.com>" / " A@B.com " → "a@b.com". 주소가 아니면 ''.
function normEmail(raw: string | null | undefined): string {
  if (!raw) return ''
  const angle = /<([^>]+)>/.exec(raw)
  const s = (angle?.[1] ?? raw).trim().replace(/^mailto:/i, '').toLowerCase()
  return s.includes('@') ? s : ''
}

// LIKE/ILIKE 패턴에서 리터럴로 쓰기 위한 escape (Postgres 기본 escape 문자 '\').
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
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

async function refreshGoogleToken(storedToken: string): Promise<string> {
  // DB 에 암호화되어 저장된 토큰 복호화 (평문 저장 기존 토큰도 그대로 통과)
  const refreshToken = await decryptToken(storedToken)
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
