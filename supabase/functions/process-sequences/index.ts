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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

const RUN_BUDGET_MS = 50_000
const GMAIL_CALL_BUDGET_MS = 4_000
const MAX_STEPS_PER_RUN = 40

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
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
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
        if (contact.is_unsubscribed) {
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
          await supabase.schema('mailcaster').rpc('defer_enrollment', {
            p_enrollment_id: claim.enrollment_id, p_minutes: 360,
          })
          deferred++
          continue
        }

        // C1 멱등 가드 — 이 (시퀀스, contact, 스텝) 발송이 이미 존재하면 재발송 금지.
        // (이전 run 에서 Gmail 발송 성공 후 advance_enrollment 실패/크래시 시, 클레임의 15분 hold 가
        //  만료되면 같은 스텝을 또 보낼 위험 → DB 에 sent/pending 흔적이 있으면 enrollment 만 진행시켜 복구.)
        const { data: existingTm } = await supabase
          .schema('mailcaster').from('thread_messages')
          .select('id, gmail_thread_id, rfc_message_id')
          .eq('sequence_id', claim.sequence_id)
          .eq('contact_id', claim.contact_id)
          .eq('sequence_step_order', claim.step_order)
          .in('status', ['sent', 'pending'])
          .limit(1)
          .maybeSingle()
        if (existingTm) {
          const ex = existingTm as { gmail_thread_id: string | null; rfc_message_id: string | null }
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
        const bodyHtml = renderTemplate(step.body_html, vars)

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
        const htmlWithPixel = injectTrackingPixel(bodyHtml, buildThreadTrackingPixel(tmId))

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
  supabase: ReturnType<typeof createClient>,
  enrollmentId: string,
  status: 'failed' | 'stopped',
  reason: string,
) {
  await supabase.schema('mailcaster').from('sequence_enrollments')
    .update({ status, stopped_reason: status, last_error: reason.slice(0, 500), next_run_at: null })
    .eq('id', enrollmentId)
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

function buildThreadTrackingPixel(tmId: string): string {
  const url = `${SUPABASE_URL}/functions/v1/track-open?tmid=${encodeURIComponent(tmId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

function injectTrackingPixel(html: string, pixelHtml: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  return html + pixelHtml
}

async function refreshGoogleToken(refreshToken: string): Promise<string> {
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
    if ((e as Error).name === 'AbortError') {
      const err = new Error('Gmail API 타임아웃(25초)') as Error & { status?: number }
      err.status = 504
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text()
    let message = `Gmail API ${res.status}`
    try { message = JSON.parse(body)?.error?.message || message } catch { if (body) message = body }
    const err = new Error(message) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return (await res.json()) as { id: string; threadId: string }
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
  const toHeader = input.toName ? `${encodeHeader(input.toName)} <${cleanTo}>` : cleanTo
  const bodyBase64 = wrapBase64(utf8ToBase64(input.html))

  const headers: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (input.inReplyTo) {
    const w = input.inReplyTo.trim().startsWith('<') ? input.inReplyTo.trim() : `<${input.inReplyTo.trim()}>`
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
  if (/^[\x20-\x7E]+$/.test(name) && !/[<>"@,;:\\]/.test(name)) return `${name} <${email}>`
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
