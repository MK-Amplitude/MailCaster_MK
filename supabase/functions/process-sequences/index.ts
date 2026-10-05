// =============================================
// process-sequences — 시퀀스 자동 후속 발송 스케줄러 (고도화 Tier 1-B)
// ---------------------------------------------
// pg_cron 이 매 분 호출. claim_due_sequence_steps 로 due enrollment 를 원자적으로
// 집어(FOR UPDATE SKIP LOCKED + 15분 hold) 발송 후 advance_enrollment 로 다음 스텝 예약.
//
// 발송 직전 가드: contact 수신거부/반송 → 시퀀스 정지(stop_active_enrollments_for_contact).
// (회신 정지는 check-replies/check-inbox 가 비동기로 처리 — 1-C)
//
// 스텝1(또는 thread 미시작) = 새 메일(mode='new'), 이후 = 같은 thread 후속(mode='followup',
// threadId + In-Reply-To). 모든 발송은 thread_messages 에 기록되어 오픈/회신 추적과 연동.
//
// Auth: Authorization: Bearer <CRON_SECRET> (verify_jwt=false, config.toml).
// =============================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decryptToken } from '../_shared/tokenCrypto.ts'
import { isCronAuthorized } from '../_shared/cronAuth.ts'
import { wrapLinksForClickTracking } from '../_shared/clickLinks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
// 클릭 링크 서명 전용 키 (track-click 과 동일 우선순위) — 미설정 시 CRON_SECRET 폴백
const CLICK_SIGNING_SECRET =
  Deno.env.get('CLICK_SIGNING_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

const RUN_BUDGET_MS = 50_000
const GMAIL_CALL_BUDGET_MS = 4_000
const MAX_STEPS_PER_RUN = 40

// C-5 — 요청 송신 후 결과를 모름(타임아웃/네트워크 오류/2xx 응답 해석 실패). Gmail 이 이미
// 발송했을 수 있으므로 재시도·재예약 금지 → thread_message 는 이 문구로 failed, enrollment 는 종료.
const UNCERTAIN_SEND_MESSAGE = '전송 결과 불확실 — Gmail 보낸편지함 확인 후 필요 시 개별 재발송'

// PostgREST max-rows 와 무관하게 빈 페이지까지 읽는 페이지 크기 (C-7)
const PAGE_SIZE = 1000

// sendGmail 이 던지는 오류 — ambiguous 면 발송됐을 수 있음(재시도 금지).
type SendError = Error & { status?: number; ambiguous?: boolean }

// supabase-js 클라이언트 (Edge 에서는 생성 타입을 쓰지 않음 — send-scheduled-campaigns 와 동일)
// deno-lint-ignore no-explicit-any
type Db = any // eslint-disable-line @typescript-eslint/no-explicit-any

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Claim {
  enrollment_id: string
  org_id: string
  sequence_id: string
  contact_id: string
  step_order: number
  last_thread_id: string | null
  last_rfc_message_id: string | null
  sender_user_id: string
}

interface StepRow {
  sequence_id: string
  step_order: number
  subject: string
  body_html: string
}

interface ContactRow {
  id: string
  org_id: string
  email: string
  name: string | null
  company: string | null
  company_ko: string | null
  company_en: string | null
  parent_group: string | null
  job_title: string | null
  display_title: string | null
  department: string | null
  is_unsubscribed: boolean | null
  is_bounced: boolean | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // 내부 cron 전용 — CRON_SECRET 검증
  const auth = req.headers.get('Authorization') ?? ''
  if (!isCronAuthorized(auth, CRON_SECRET)) {
    return json({ error: 'unauthorized' }, 401)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const runStart = Date.now()
  let claimed = 0
  let sent = 0
  let stopped = 0
  let failed = 0
  let deferred = 0

  // org 별 발송 가드(설정 + rolling 24h 발송 수) 캐시 — 같은 org 반복 조회 방지.
  const orgGuards = new Map<string, OrgGuard>()
  async function guardFor(orgId: string): Promise<OrgGuard> {
    const cached = orgGuards.get(orgId)
    if (cached) return cached
    const g = await loadOrgGuard(supabase, orgId)
    orgGuards.set(orgId, g)
    return g
  }

  // org 별 수신거부 주소(소문자) 캐시 — contact 플래그와 별개로 mailcaster.unsubscribes 대조.
  // (contacts.is_unsubscribed 동기화가 늦거나 빠진 경우 대비) 조회 실패 시 null → 발송 보류.
  const orgUnsubs = new Map<string, Set<string> | null>()
  async function unsubscribedFor(orgId: string): Promise<Set<string> | null> {
    if (orgUnsubs.has(orgId)) return orgUnsubs.get(orgId) ?? null
    const set = await loadOrgUnsubscribes(supabase, orgId)
    orgUnsubs.set(orgId, set)
    return set
  }

  try {
    // 1) due enrollment 원자적 클레임
    const { data: claims, error: claimErr } = await supabase
      .schema('mailcaster')
      .rpc('claim_due_sequence_steps', { p_limit: MAX_STEPS_PER_RUN })
    if (claimErr) throw claimErr
    const claimList = (claims ?? []) as Claim[]
    claimed = claimList.length
    if (claimed === 0) {
      return json({ ok: true, claimed: 0, sent: 0, stopped: 0, failed: 0 })
    }

    // 2) 스텝/컨택트 batch fetch
    const seqIds = [...new Set(claimList.map((c) => c.sequence_id))]
    const contactIds = [...new Set(claimList.map((c) => c.contact_id))]

    const [stepsRes, contactsRes] = await Promise.all([
      supabase.schema('mailcaster').from('sequence_steps')
        .select('sequence_id, step_order, subject, body_html')
        .in('sequence_id', seqIds),
      supabase.schema('mailcaster').from('contacts')
        .select('id, org_id, email, name, company, company_ko, company_en, parent_group, job_title, display_title, department, is_unsubscribed, is_bounced')
        .in('id', contactIds),
    ])
    if (stepsRes.error) throw stepsRes.error
    if (contactsRes.error) throw contactsRes.error

    const stepMap = new Map<string, StepRow>()
    for (const s of (stepsRes.data ?? []) as StepRow[]) {
      stepMap.set(`${s.sequence_id}:${s.step_order}`, s)
    }
    const contactMap = new Map<string, ContactRow>()
    for (const c of (contactsRes.data ?? []) as ContactRow[]) {
      contactMap.set(c.id, c)
    }

    // C1 멱등 가드용 batch prefetch — 클레임 튜플의 기존 sent/pending thread_messages 와
    // '결과 불확실' failed 행(C-5)을 한 번에 조회해 Map(seq:contact:step) 으로 보관.
    // 조회 실패 시 가드가 비어 재발송될 수 있으므로 run 전체를 중단한다 (claim 15분 hold 후 재시도).
    // 빈 페이지까지 페이지네이션 (C-7).
    const stepOrders = [...new Set(claimList.map((c) => c.step_order))]
    const existingTmMap = new Map<
      string,
      { gmail_thread_id: string | null; rfc_message_id: string | null; uncertain: boolean }
    >()
    for (let offset = 0; ; ) {
      const { data: tmRows, error: tmPrefetchErr } = await supabase
        .schema('mailcaster').from('thread_messages')
        .select('id, sequence_id, contact_id, sequence_step_order, status, error_message, gmail_thread_id, rfc_message_id')
        .in('sequence_id', seqIds)
        .in('contact_id', contactIds)
        .in('sequence_step_order', stepOrders)
        .in('status', ['sent', 'pending', 'failed'])
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
      if (tmPrefetchErr) throw tmPrefetchErr
      const rows = (tmRows ?? []) as Array<{
        sequence_id: string; contact_id: string; sequence_step_order: number
        status: string; error_message: string | null
        gmail_thread_id: string | null; rfc_message_id: string | null
      }>
      for (const r of rows) {
        const uncertain = r.status === 'failed'
        // 일반 failed(미발송 확정) 는 재시도 대상 — 가드에서 제외
        if (uncertain && r.error_message !== UNCERTAIN_SEND_MESSAGE) continue
        const key = `${r.sequence_id}:${r.contact_id}:${r.sequence_step_order}`
        const prev = existingTmMap.get(key)
        // sent/pending 흔적이 있으면 그쪽 우선 (advance 로 복구), 불확실만 있으면 종료 대상
        if (prev && !prev.uncertain) continue
        existingTmMap.set(key, {
          gmail_thread_id: r.gmail_thread_id,
          rfc_message_id: r.rfc_message_id,
          uncertain,
        })
      }
      if (rows.length === 0) break
      offset += rows.length
    }

    // 3) 발송자(user)별 그룹핑 — 각자 Gmail 토큰
    const byUser = new Map<string, Claim[]>()
    for (const c of claimList) {
      if (!byUser.has(c.sender_user_id)) byUser.set(c.sender_user_id, [])
      byUser.get(c.sender_user_id)!.push(c)
    }

    userLoop: for (const [userId, list] of byUser) {
      if (Date.now() - runStart > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break

      // 발송자 profile + 토큰
      const { data: profile } = await supabase
        .schema('mailcaster').from('profiles')
        .select('email, display_name, default_sender_name, google_refresh_token')
        .eq('id', userId)
        .single()
      if (!profile?.google_refresh_token || !profile?.email) {
        // 토큰 없음 — 15분 hold 후 재시도(재로그인 대기). 건드리지 않음.
        continue
      }
      const fromEmail = profile.email as string
      const fromName =
        (profile.default_sender_name as string | null) ??
        (profile.display_name as string | null) ??
        ''
      const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail

      let accessToken: string
      try {
        accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
      } catch {
        continue // 토큰 갱신 실패 — hold 후 재시도
      }

      for (const claim of list) {
        if (Date.now() - runStart > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) break userLoop

        const step = stepMap.get(`${claim.sequence_id}:${claim.step_order}`)
        const contact = contactMap.get(claim.contact_id)

        // 스텝 누락(설정 변경) → 다음 스텝으로 건너뜀(advance), 없으면 완료.
        if (!step) {
          await supabase.schema('mailcaster').rpc('advance_enrollment', {
            p_enrollment_id: claim.enrollment_id,
            p_sent_step_order: claim.step_order,
            p_thread_id: claim.last_thread_id,
            p_rfc_message_id: claim.last_rfc_message_id,
          })
          continue
        }
        // 컨택트 누락 → 실패 종료
        if (!contact) {
          await terminate(supabase, claim.enrollment_id, 'failed', '컨택트를 찾을 수 없음')
          failed++
          continue
        }
        // 가드: 수신거부/반송 → 정지
        // contact 플래그 + 조직 수신거부 목록(unsubscribes, lower(email)) 둘 다 대조.
        const unsubs = await unsubscribedFor(claim.org_id)
        if (!unsubs) {
          // 수신거부 목록을 확인하지 못함 — 보내지 않는다. claim 의 15분 hold 후 재시도.
          console.warn('[process-sequences] unsubscribes lookup failed — skip', claim.enrollment_id)
          continue
        }
        if (contact.is_unsubscribed || unsubs.has(normalizeEmail(contact.email))) {
          await supabase.schema('mailcaster').rpc('stop_active_enrollments_for_contact', {
            p_org_id: claim.org_id, p_contact_id: claim.contact_id, p_reason: 'unsubscribed',
          })
          stopped++
          continue
        }
        if (contact.is_bounced) {
          await supabase.schema('mailcaster').rpc('stop_active_enrollments_for_contact', {
            p_org_id: claim.org_id, p_contact_id: claim.contact_id, p_reason: 'bounced',
          })
          stopped++
          continue
        }

        // Tier 2 가드레일 — 업무시간 발송창 + 일일 한도/워밍업.
        const guard = await guardFor(claim.org_id)
        if (!isWithinSendWindow(guard)) {
          // 창 밖 — 다음 시간대까지 미룸(60분).
          await supabase.schema('mailcaster').rpc('defer_enrollment', {
            p_enrollment_id: claim.enrollment_id, p_minutes: 60,
          })
          deferred++
          continue
        }
        if (guard.sentToday >= effectiveDailyLimit(guard)) {
          // 일일 한도 소진 — 다음 날 창까지 미룸(6시간 후 재평가).
          // (profiles.daily_send_limit 은 설정 화면 안내대로 기록용 — 여기서 강제하지 않음.
          //  시퀀스 한도는 org_send_settings 하나만 적용)
          await supabase.schema('mailcaster').rpc('defer_enrollment', {
            p_enrollment_id: claim.enrollment_id, p_minutes: 360,
          })
          deferred++
          continue
        }

        // C1 멱등 가드 — 이 (시퀀스, contact, 스텝) 발송이 이미 존재하면 재발송 금지.
        // (이전 run 에서 Gmail 발송 성공 후 advance_enrollment 실패/크래시 시, 클레임의 15분 hold 가
        //  만료되면 같은 스텝을 또 보낼 위험 → DB 에 sent/pending 흔적이 있으면 enrollment 만 진행시켜 복구.)
        const ex = existingTmMap.get(
          `${claim.sequence_id}:${claim.contact_id}:${claim.step_order}`,
        )
        if (ex?.uncertain) {
          // C-5 — 이전 발송 결과 불확실(이미 발송됐을 수 있음). 이전 run 의 enrollment 종료가
          // 반영되지 않은 경우 — 재발송하지 않고 다시 종료한다.
          await terminate(supabase, claim.enrollment_id, 'failed', UNCERTAIN_SEND_MESSAGE)
          failed++
          continue
        }
        if (ex) {
          const { error: advErr } = await supabase.schema('mailcaster').rpc('advance_enrollment', {
            p_enrollment_id: claim.enrollment_id,
            p_sent_step_order: claim.step_order,
            p_thread_id: ex.gmail_thread_id ?? claim.last_thread_id,
            p_rfc_message_id: ex.rfc_message_id ?? claim.last_rfc_message_id,
          })
          if (advErr) console.warn('[process-sequences] recover advance fail', claim.enrollment_id, advErr.message)
          continue
        }

        // thread 미시작이면 첫 메일(new), 있으면 후속(followup)
        const isFirst = !claim.last_thread_id
        const mode = isFirst ? 'new' : 'followup'
        const vars = buildContactVariables(contact)
        const subject = renderTemplate(step.subject, vars)
        const bodyHtml = renderTemplateHtml(step.body_html, vars)

        // thread_messages pending 행 insert → tmId
        const { data: tmRow, error: tmErr } = await supabase
          .schema('mailcaster').from('thread_messages')
          .insert({
            org_id: claim.org_id,
            user_id: userId,
            contact_id: claim.contact_id,
            mode,
            to_email: contact.email,
            to_name: contact.name,
            subject,
            body_html: bodyHtml,
            gmail_thread_id: claim.last_thread_id,
            in_reply_to_message_id: claim.last_rfc_message_id,
            status: 'pending',
            sequence_id: claim.sequence_id,
            sequence_step_order: claim.step_order,
          })
          .select('id')
          .single()
        if (tmErr || !tmRow) {
          await supabase.schema('mailcaster').rpc('fail_enrollment_step', {
            p_enrollment_id: claim.enrollment_id,
            p_error: `thread_messages insert: ${tmErr?.message ?? 'unknown'}`,
            p_retry_minutes: 30,
          })
          failed++
          continue
        }
        const tmId = (tmRow as { id: string }).id
        // 링크 클릭 트래킹 — 본문 링크를 track-click 리다이렉트로 래핑 (tmid 기준)
        const linkWrapped = await wrapLinksForClickTracking(
          bodyHtml,
          { tmid: tmId },
          SUPABASE_URL,
          CLICK_SIGNING_SECRET,
        )
        // 수신거부 안내 — 시퀀스는 반복 자동 발송이라 광고성 정보의 수신거부 방법 고지가 필수
        // (정보통신망법 제50조). 회신 '수신거부' 는 check-replies 가 감지해 등록·시퀀스 정지.
        // 문구는 캠페인 일괄 모드와 동일해야 check-replies 의 자체 footer 제거(OWN_FOOTER_PATTERNS)가 동작.
        const withFooter = appendOptOutFooter(linkWrapped)
        const htmlWithPixel = injectTrackingPixel(withFooter, buildThreadTrackingPixel(tmId))

        // 발송
        let result: { id: string; threadId: string } | null = null
        try {
          result = await sendGmail({
            accessToken,
            from,
            to: contact.email,
            toName: contact.name,
            subject,
            html: htmlWithPixel,
            threadId: claim.last_thread_id ?? undefined,
            inReplyTo: claim.last_rfc_message_id ?? undefined,
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if ((e as SendError)?.ambiguous) {
            // C-5 — 요청 송신 후 결과 불명. Gmail 이 이미 발송했을 수 있으므로 재시도/재예약하지
            // 않는다: thread_message 는 '결과 불확실' failed, enrollment 는 failed 로 종료
            // (자동 재발송 경로 차단). thread_message 갱신이 실패해 pending 으로 남아도 C1 가드가
            // '흔적 있음' 으로 보고 재발송하지 않는다.
            console.error('[process-sequences] send outcome unknown', claim.enrollment_id, msg)
            const { error: tmUpdErr } = await supabase.schema('mailcaster').from('thread_messages')
              .update({ status: 'failed', error_message: UNCERTAIN_SEND_MESSAGE })
              .eq('id', tmId)
            if (tmUpdErr) console.error('[process-sequences] uncertain-mark fail', tmId, tmUpdErr.message)
            await terminate(supabase, claim.enrollment_id, 'failed', UNCERTAIN_SEND_MESSAGE)
            guard.sentToday++ // 발송됐을 수 있음 — 일일 한도는 보수적으로 차감
            failed++
            continue
          }
          // Gmail 이 응답한 오류(429/5xx 등) 또는 연결 단계 실패(미송신 확정) — 재시도 예약.
          await supabase.schema('mailcaster').from('thread_messages')
            .update({ status: 'failed', error_message: msg.slice(0, 500) })
            .eq('id', tmId)
          await supabase.schema('mailcaster').rpc('fail_enrollment_step', {
            p_enrollment_id: claim.enrollment_id, p_error: msg, p_retry_minutes: 60,
          })
          failed++
          continue
        }

        // 발송 성공 — thread_messages 확정 + rfc id
        let ownRfc: string | null = null
        try {
          ownRfc = await fetchMessageRfcId(accessToken, result.id)
        } catch { /* best-effort */ }

        await supabase.schema('mailcaster').from('thread_messages')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            gmail_message_id: result.id,
            gmail_thread_id: result.threadId,
            rfc_message_id: ownRfc,
          })
          .eq('id', tmId)

        guard.sentToday++ // 일일 한도 로컬 카운트 증가
        // enrollment 진행 — 다음 스텝 예약 / 완료.
        // 실패 시 로그만 — 발송된 thread_messages(sent) 흔적이 남아 다음 tick 의 C1 멱등 가드가
        // 재발송 없이 복구(advance)한다.
        const { error: advErr } = await supabase.schema('mailcaster').rpc('advance_enrollment', {
          p_enrollment_id: claim.enrollment_id,
          p_sent_step_order: claim.step_order,
          p_thread_id: result.threadId,
          p_rfc_message_id: ownRfc,
        })
        if (advErr) {
          console.warn('[process-sequences] advance fail (멱등 가드가 다음 tick 에 복구)', claim.enrollment_id, advErr.message)
        }
        sent++
      }
    }

    return json({ ok: true, claimed, sent, stopped, failed, deferred, ms: Date.now() - runStart })
  } catch (e) {
    console.error('[process-sequences] fatal', e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// enrollment 을 터미널 상태로 직접 마킹 (service_role).
async function terminate(
  supabase: Db,
  enrollmentId: string,
  status: 'failed' | 'stopped',
  reason: string,
) {
  const { error } = await supabase.schema('mailcaster').from('sequence_enrollments')
    .update({ status, stopped_reason: status, last_error: reason.slice(0, 500), next_run_at: null })
    .eq('id', enrollmentId)
  if (error) console.error('[process-sequences] terminate fail', enrollmentId, error.message)
}

function normalizeEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

// 조직 수신거부 주소(소문자) — 빈 페이지까지 페이지네이션 (C-7). 실패 시 null (발송 보류).
async function loadOrgUnsubscribes(
  supabase: Db,
  orgId: string,
): Promise<Set<string> | null> {
  const out = new Set<string>()
  for (let offset = 0; ; ) {
    const { data, error } = await supabase
      .schema('mailcaster').from('unsubscribes')
      .select('id, email')
      .eq('org_id', orgId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      console.error('[process-sequences] unsubscribes load fail', orgId, error.message)
      return null
    }
    const rows = (data ?? []) as Array<{ email: string | null }>
    for (const r of rows) {
      const e = normalizeEmail(r.email)
      if (e) out.add(e)
    }
    if (rows.length === 0) break
    offset += rows.length
  }
  return out
}

// ---- Tier 2 발송 가드레일 (org_send_settings) ----
interface OrgGuard {
  sentToday: number       // rolling 24h org 발송 수
  dailyLimit: number
  windowStart: number     // 발송창 시작 시(포함)
  windowEnd: number       // 발송창 끝 시(미포함)
  sendOnWeekends: boolean
  timezone: string
  warmupStart: number
  warmupPerDay: number
  warmupStartedAt: string | null
}

async function loadOrgGuard(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
): Promise<OrgGuard> {
  const { data: s } = await supabase
    .schema('mailcaster').from('org_send_settings')
    .select('*').eq('org_id', orgId).maybeSingle()
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { count } = await supabase
    .schema('mailcaster').from('thread_messages')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('status', 'sent').gte('sent_at', since)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = s as any
  return {
    sentToday: count ?? 0,
    dailyLimit: row?.daily_send_limit ?? 100,
    windowStart: row?.window_start_hour ?? 8,
    windowEnd: row?.window_end_hour ?? 18,
    sendOnWeekends: row?.send_on_weekends ?? false,
    timezone: row?.timezone ?? 'Asia/Seoul',
    warmupStart: row?.warmup_start ?? 0,
    warmupPerDay: row?.warmup_per_day ?? 20,
    warmupStartedAt: row?.warmup_started_at ?? null,
  }
}

function effectiveDailyLimit(g: OrgGuard): number {
  if (g.warmupStart > 0 && g.warmupStartedAt) {
    const startMs = Date.parse(`${g.warmupStartedAt}T00:00:00Z`)
    if (!Number.isNaN(startMs)) {
      const days = Math.max(0, Math.floor((Date.now() - startMs) / 86400_000))
      return Math.min(g.dailyLimit, g.warmupStart + g.warmupPerDay * days)
    }
  }
  return g.dailyLimit
}

function isWithinSendWindow(g: OrgGuard): boolean {
  try {
    const now = new Date()
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: g.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
      10,
    )
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: g.timezone, weekday: 'short' }).format(now)
    if ((weekday === 'Sat' || weekday === 'Sun') && !g.sendOnWeekends) return false
    return hour >= g.windowStart && hour < g.windowEnd
  } catch {
    return true // timezone 파싱 실패 시 보수적으로 허용 (발송이 영구 막히는 것 방지)
  }
}

function buildContactVariables(c: ContactRow): Record<string, string> {
  const company = c.company_ko || c.company || c.company_en || ''
  const name = c.name ?? ''
  const firstName = name.trim().split(/\s+/)[0] ?? ''
  return {
    name,
    first_name: firstName,
    email: c.email,
    company,
    company_ko: c.company_ko ?? '',
    company_en: c.company_en ?? '',
    parent_group: c.parent_group ?? '',
    job_title: c.job_title ?? c.display_title ?? '',
    department: c.department ?? '',
  }
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

function buildThreadTrackingPixel(tmId: string): string {
  const url = `${SUPABASE_URL}/functions/v1/track-open?tmid=${encodeURIComponent(tmId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

const OPT_OUT_FOOTER_HTML =
  `<p style="margin:24px 0 0 0;font-size:11px;line-height:1.5;color:#9ca3af;">본 메일의 수신을 원하지 않으시면 이 메일에 '수신거부'라고 회신해 주세요.</p>`

function appendOptOutFooter(html: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${OPT_OUT_FOOTER_HTML}</body>`)
  return html + OPT_OUT_FOOTER_HTML
}

function injectTrackingPixel(html: string, pixelHtml: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  return html + pixelHtml
}

async function refreshGoogleToken(storedToken: string): Promise<string> {
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
        const j = await res.json()
        if (!j.access_token) throw new Error('access_token 미반환')
        return j.access_token as string
      }
      const body = await res.text()
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Google OAuth ${res.status}: ${body.slice(0, 200)}`)
      }
      lastErr = new Error(`Google OAuth ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 500 * attempt))
  }
  throw lastErr ?? new Error('token refresh failed')
}

// ---- Gmail 발송 (threadId + In-Reply-To/References 지원, text/html) ----
interface GmailSend {
  accessToken: string
  from: string
  to: string
  toName?: string | null
  subject: string
  html: string
  threadId?: string
  inReplyTo?: string
}

async function sendGmail(input: GmailSend): Promise<{ id: string; threadId: string }> {
  const mime = buildMime(input)
  const raw = b64url(mime)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  let res: Response
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw }),
      signal: controller.signal,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 연결 수립 단계 실패(DNS/TCP connect/TLS) — 요청이 나가기 전이라 미발송 확정 → 재시도 가능.
    if ((e as Error)?.name !== 'AbortError' && isPreSendNetworkError(msg)) {
      throw new Error(`Gmail API 연결 실패: ${msg}`) as SendError
    }
    // 타임아웃/그 외 네트워크 오류 — 요청이 이미 전송돼 Gmail 이 발송했을 수 있다 (C-5).
    const detail = (e as Error)?.name === 'AbortError' ? '타임아웃 25초 초과' : msg
    const err = new Error(`${UNCERTAIN_SEND_MESSAGE} (${detail})`) as SendError
    err.ambiguous = true
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let message = `Gmail API ${res.status}`
    try { message = JSON.parse(body)?.error?.message || message } catch { if (body) message = body }
    const err = new Error(message) as SendError
    err.status = res.status
    throw err
  }
  // 2xx — 발송은 됐을 가능성이 높다. 본문을 못 읽거나 id 가 없으면 결과 불확실 (재시도 금지).
  let parsed: { id?: string; threadId?: string } | null = null
  try {
    parsed = (await res.json()) as { id?: string; threadId?: string }
  } catch (e) {
    const err = new Error(
      `${UNCERTAIN_SEND_MESSAGE} (응답 해석 실패: ${e instanceof Error ? e.message : String(e)})`,
    ) as SendError
    err.ambiguous = true
    throw err
  }
  if (!parsed?.id) {
    const err = new Error(`${UNCERTAIN_SEND_MESSAGE} (응답에 message id 없음)`) as SendError
    err.ambiguous = true
    throw err
  }
  return { id: parsed.id, threadId: parsed.threadId ?? parsed.id }
}

// Deno fetch 의 연결 수립 단계 오류 — 이 단계에서는 요청이 서버에 도달하지 않는다.
// (send-scheduled-campaigns 의 isPreSendNetworkError 와 동일 기준)
function isPreSendNetworkError(msg: string): boolean {
  return /error trying to connect|dns error|failed to lookup address|connection refused/i.test(msg)
}

async function fetchMessageRfcId(accessToken: string, gmailMessageId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const headers = data.payload?.headers ?? []
    const found = headers.find((h: { name: string }) => h.name.toLowerCase() === 'message-id')
    return found?.value ?? null
  } catch {
    return null
  }
}

function buildMime(input: GmailSend): string {
  const cleanFrom = encodeAddressHeader(stripCRLF(input.from))
  const cleanTo = stripCRLF(input.to)
  // 표시 이름은 encodeAddressHeader 경유 — ASCII 특수문자(콤마 등) quoted-string 처리
  const toHeader = input.toName
    ? encodeAddressHeader(`${stripCRLF(input.toName).replace(/[<>]/g, '')} <${cleanTo}>`)
    : cleanTo
  const bodyBase64 = wrapBase64(utf8ToBase64(input.html))

  const headers: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (input.inReplyTo) {
    // stripCRLF — rfc_message_id 는 DB 를 거쳐 오므로 (recipients 행은 조직 멤버가
    // 만질 수 있음) 다른 헤더들과 동일하게 CR/LF 인젝션을 차단한다.
    const rid = stripCRLF(input.inReplyTo).trim()
    const w = rid.startsWith('<') ? rid : `<${rid}>`
    headers.push(`In-Reply-To: ${w}`, `References: ${w}`)
  }
  headers.push(
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  )
  return headers.join('\r\n') + '\r\n\r\n' + bodyBase64
}

function stripCRLF(s: string): string {
  return s.replace(/[\r\n\0\u2028\u2029]/g, '')
}
function encodeOneWord(s: string): string {
  return `=?UTF-8?B?${utf8ToBase64(s)}?=`
}
function encodeAddressHeader(addr: string): string {
  const m = addr.match(/^\s*(.+?)\s*<([^>]+)>\s*$/)
  if (!m) return addr
  const name = m[1].trim().replace(/^"(.*)"$/, '$1')
  const email = m[2].trim()
  if (!name) return `<${email}>`
  if (/^[\x20-\x7E]+$/.test(name)) {
    if (!/[<>"@,;:\\]/.test(name)) return `${name} <${email}>`
    // ASCII 특수문자(콤마 등) — quoted-string 필수. encodeHeader 는 ASCII 를 그대로 반환함.
    return `"${name.replace(/([\\"])/g, '\\$1')}" <${email}>`
  }
  return `${encodeHeader(name)} <${email}>`
}
function encodeHeader(value: string): string {
  const clean = stripCRLF(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean
  const encoder = new TextEncoder()
  const MAX = 42
  const parts: string[] = []
  let buf = ''
  let bytes = 0
  for (const ch of clean) {
    const cb = encoder.encode(ch).length
    if (bytes + cb > MAX && buf) { parts.push(encodeOneWord(buf)); buf = ''; bytes = 0 }
    buf += ch; bytes += cb
  }
  if (buf) parts.push(encodeOneWord(buf))
  return parts.join(' ')
}
function wrapBase64(s: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width))
  return chunks.join('\r\n')
}
function utf8ToBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
}
function b64url(input: string): string {
  return btoa(unescape(encodeURIComponent(input))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
