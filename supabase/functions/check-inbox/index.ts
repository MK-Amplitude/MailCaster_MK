// Supabase Edge Function: check-inbox
// ============================================================
// 역할
// ------------------------------------------------------------
// pg_cron 이 매 5분 POST /functions/v1/check-inbox 로 호출.
// 사용자별 Gmail inbox 폴링 → contact 매칭 inbound 메일 감지 → DB 기록.
//
// 매칭 정책:
//   - From 헤더 이메일이 contacts.email (같은 org) 와 매칭 → 그 contact 의 inbound 으로 기록
//   - 매칭 없음 → contact 자동 생성 (기본값) 후 기록
//
// Incremental 폴링:
//   profiles.last_inbox_check_at 을 cursor 로 사용 — 그 이후 도착한 메일만 폴링.
//   처음 실행 (NULL) 이면 최근 24시간만 (대량 backfill 방지).
//
// 보안:
//   Authorization: Bearer <CRON_SECRET>  (pg_cron 주입)
//
// 타임아웃 복원력:
//   55초 예산. 사용자당 일정 시간 안에서 처리 못한 message id 는 다음 cron 에 이월.
//   last_inbox_check_at 은 "성공적으로 처리한 가장 늦은 메시지의 시각" 으로 갱신.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

// 한 tick 최대 실행 시간 (ms). pg_cron 55s 컷 직전 자진 종료.
const RUN_BUDGET_MS = 50_000
// 사용자당 최대 처리 메시지 수 — 폭발 방지 (대형 inbox 의 backlog 는 cron 여러 tick 으로 나눔).
// 100 으로 둠: 한 초에 윈도우가 가득 차 cursor 후퇴가 무효화되는 극단 케이스 (A-1) 완화.
const PER_USER_MAX_MESSAGES = 100
// 처음 실행 (last_inbox_check_at NULL) 시 최근 N 시간만 폴링 — 과거 모든 메일 backfill 방지
const INITIAL_LOOKBACK_HOURS = 24
// 한 메시지 fetch 평균 예산
const MESSAGE_FETCH_BUDGET_MS = 1_500

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
    // 1) Google 토큰 보유한 모든 user 가져오기
    const { data: profiles, error: pErr } = await supabase
      .schema('mailcaster')
      .from('profiles')
      .select('id, email, google_refresh_token, last_inbox_check_at, last_history_id, default_org_id')
      .not('google_refresh_token', 'is', null)

    if (pErr) throw pErr
    const candidates = (profiles ?? []) as Array<{
      id: string
      email: string
      google_refresh_token: string
      last_inbox_check_at: string | null
      last_history_id: string | null
      default_org_id: string | null
    }>

    let totalProcessed = 0
    let totalRecorded = 0
    let totalContactsCreated = 0
    let tokenErrors = 0
    let gmailErrors = 0

    userLoop: for (const profile of candidates) {
      if (Date.now() - runStartedAt > RUN_BUDGET_MS - MESSAGE_FETCH_BUDGET_MS) break

      // org_id 결정 — profile 의 default_org 또는 첫 org 멤버십.
      // default 가 NULL 이면 stub (skip — 이런 사용자는 org 미설정 상태)
      const orgId = profile.default_org_id
      if (!orgId) continue

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

      // 2) Gmail inbox 폴링 — last_inbox_check_at 이후 도착한 메시지만
      const cursorMs = profile.last_inbox_check_at
        ? Date.parse(profile.last_inbox_check_at)
        : Date.now() - INITIAL_LOOKBACK_HOURS * 3600_000
      // Gmail search query: after:<unix>. label:inbox 만.
      // Gmail 의 after: 는 초 단위. 1초 단위라 약간 redundant 가 있을 수 있으나
      // UNIQUE (org_id, gmail_message_id) 가 중복 INSERT 차단.
      const afterSec = Math.floor(cursorMs / 1000)
      const userEmailLower = profile.email.toLowerCase()

      // 메시지 발견: History API 우선(델타), 실패/미보유 시 시간기반 폴백.
      //   - usedHistory=true  → listIds 는 history.list 의 messageAdded. newHistoryId 갱신.
      //   - usedHistory=false → 기존 after:<sec> 전체 스캔 (첫 실행/만료 폴백).
      // 처리 로직(아래) 과 cursor 갱신만 분기될 뿐, per-message 처리는 동일.
      let listIds: string[] = []
      let usedHistory = false
      let newHistoryId: string | null = null
      if (profile.last_history_id) {
        try {
          const hist = await fetchHistoryMessageIds(
            accessToken,
            profile.last_history_id,
            PER_USER_MAX_MESSAGES,
          )
          listIds = hist.ids
          newHistoryId = hist.historyId
          usedHistory = true
        } catch (e) {
          // 404(historyId 만료) 또는 기타 오류 → 이번 tick 은 시간기반 폴백.
          console.warn(
            '[check-inbox] history fallback uid=',
            profile.id,
            e instanceof Error ? e.message : e,
          )
          usedHistory = false
        }
      }
      if (!usedHistory) {
        try {
          listIds = await fetchInboxMessageIds(accessToken, afterSec, PER_USER_MAX_MESSAGES)
        } catch (e) {
          gmailErrors++
          console.warn(
            '[check-inbox] list fail uid=',
            profile.id,
            e instanceof Error ? e.message : e,
          )
          continue
        }
      }

      if (listIds.length === 0) {
        // 새 메시지 없음 — cursor 회전 + History 커서 갱신.
        const upd: { last_inbox_check_at: string; last_history_id?: string } = {
          last_inbox_check_at: new Date().toISOString(),
        }
        if (usedHistory && newHistoryId) {
          upd.last_history_id = newHistoryId
        } else if (!usedHistory) {
          // 시간기반인데 새 메일 0건 = 백로그 없음 → 다음 tick 부터 History API 사용하도록 현재 historyId 저장.
          try {
            upd.last_history_id = await fetchCurrentHistoryId(accessToken)
          } catch {
            /* 실패해도 다음 tick 에 재시도 */
          }
        }
        await supabase
          .schema('mailcaster')
          .from('profiles')
          .update(upd)
          .eq('id', profile.id)
        continue
      }

      // 윈도우가 가득 찼는지 — Gmail list 는 newest-first 라, 정확히 limit 개가 왔으면
      // 그 30통 밖에 더 오래된 미처리 메시지가 남아있을 수 있음 (after:<cursor> 범위 내).
      const windowFull = listIds.length >= PER_USER_MAX_MESSAGES

      // 3) 각 메시지 fetch + 처리.
      //   - latestProcessedMs: 처리한 가장 늦은 시각 (윈도우가 다 비워졌을 때 cursor 전진용)
      //   - oldestProcessedMs: 처리한 가장 이른 시각 (윈도우 가득 찼을 때 cursor 를 여기로 후퇴 →
      //     다음 tick 이 그 이전(더 오래된)부터 이어받음. UNIQUE 가 중복 INSERT 차단하므로 안전)
      let latestProcessedMs = cursorMs
      let oldestProcessedMs = Number.MAX_SAFE_INTEGER

      for (const msgId of listIds) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - MESSAGE_FETCH_BUDGET_MS) break userLoop

        try {
          const meta = await fetchMessageMeta(accessToken, msgId)
          if (!meta) continue

          const ts = Number(meta.internalDate ?? 0)
          if (!ts) continue

          // 본인이 보낸 메일 (Sent label 또는 from=self) — 폴링 대상 아님 (이미 thread_messages 처리)
          const labels = meta.labelIds ?? []
          if (labels.includes('SENT')) continue

          const fromRaw = getHeader(meta.payload?.headers, 'From')
          if (!fromRaw) continue
          const fromParsed = parseFromAddress(fromRaw)
          if (!fromParsed.email) continue
          if (fromParsed.email === userEmailLower) continue // 자기 자신

          // 본문 + 메타
          const subject = getHeader(meta.payload?.headers, 'Subject')
          const rfcMessageId =
            getHeader(meta.payload?.headers, 'Message-ID') ??
            getHeader(meta.payload?.headers, 'Message-Id')
          const toHeader = getHeader(meta.payload?.headers, 'To') ?? ''
          const ccHeader = getHeader(meta.payload?.headers, 'Cc') ?? ''
          const toEmails = parseEmailList(toHeader).concat(parseEmailList(ccHeader))
          const bodyText = stripQuoteOnly(extractTextBody(meta.payload) ?? '').slice(0, 8000)
          const bodyHtml = extractHtmlBody(meta.payload)

          totalProcessed++

          const { data: rpcData, error: rpcErr } = await supabase
            .schema('mailcaster')
            .rpc('record_inbound_message', {
              p_org_id: orgId,
              p_user_id: profile.id,
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
              p_auto_create_contact: true,
            })
          if (rpcErr) {
            console.warn(
              '[check-inbox] record rpc fail uid=',
              profile.id,
              'mid=',
              meta.id,
              rpcErr.message,
            )
            continue
          }
          // rpcData 는 array (TABLE returning) — 첫 row
          const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
          if (result?.inserted) totalRecorded++
          if (result?.contact_created) totalContactsCreated++

          // Tier1-C — 시퀀스 자동 정지: contact 가 새로 회신/연락해오면(새 inbound)
          // 진행 중 시퀀스를 중단해 사람이 인계하게 한다. (idempotent — active 만 영향)
          if (result?.inserted && result?.contact_id) {
            const { error: stopErr } = await supabase
              .schema('mailcaster')
              .rpc('stop_active_enrollments_for_contact', {
                p_org_id: orgId,
                p_contact_id: result.contact_id,
                p_reason: 'replied',
              })
            if (stopErr) {
              console.warn('[check-inbox] seq stop fail', result.contact_id, stopErr.message)
            }
          }

          if (ts > latestProcessedMs) latestProcessedMs = ts
          if (ts < oldestProcessedMs) oldestProcessedMs = ts
        } catch (e) {
          gmailErrors++
          console.warn(
            '[check-inbox] msg fail uid=',
            profile.id,
            'mid=',
            msgId,
            e instanceof Error ? e.message : e,
          )
        }
      }

      // cursor 갱신 — History 경로와 시간기반 경로 분기.
      if (usedHistory) {
        // History 경로: 변경분을 모두 처리했으므로 historyId 전진 + 폴백 시계도 now 로 맞춰둠.
        await supabase
          .schema('mailcaster')
          .from('profiles')
          .update({
            last_history_id: newHistoryId,
            last_inbox_check_at: new Date().toISOString(),
          })
          .eq('id', profile.id)
        continue
      }

      // 시간기반 경로 (첫 실행/만료 폴백). 주의: Gmail `after:` 는 **초 단위**.
      // 후퇴 cursor 도 반드시 한 초 이상 줄어야 다음 tick 의 afterSec 가 실제로 달라짐.
      //   - 윈도우 안 가득 참 (전부 비움): 가장 늦은 처리분 +1s 로 전진 → 다음엔 새 메일만
      //   - 윈도우 가득 참 (더 오래된 미처리분 가능성): oldestProcessedMs 의 "초" 직전으로 후퇴
      //     이미 처리한 건 UNIQUE (org_id, gmail_message_id) 가 중복 INSERT 차단.
      const floorSecMs = (ms: number) => Math.floor(ms / 1000) * 1000
      let nextCursorMs: number
      if (!windowFull) {
        nextCursorMs = floorSecMs(latestProcessedMs) + 1000
      } else if (
        oldestProcessedMs !== Number.MAX_SAFE_INTEGER &&
        floorSecMs(oldestProcessedMs) > floorSecMs(cursorMs)
      ) {
        nextCursorMs = floorSecMs(oldestProcessedMs) - 1000
      } else {
        // 라이브락 방지를 위해 한 초 전진.
        nextCursorMs = floorSecMs(cursorMs) + 1000
      }
      const upd: { last_inbox_check_at: string; last_history_id?: string } = {
        last_inbox_check_at: new Date(nextCursorMs).toISOString(),
      }
      // 백로그를 다 비웠으면(!windowFull) 다음 tick 부터 History API 사용하도록 현재 historyId 저장.
      // 아직 가득 차 있으면(windowFull) 시간기반으로 backlog 를 계속 비운다 (history 로 전환하면 backlog skip 위험).
      if (!windowFull) {
        try {
          upd.last_history_id = await fetchCurrentHistoryId(accessToken)
        } catch {
          /* 실패해도 다음 tick 에 재시도 */
        }
      }
      await supabase
        .schema('mailcaster')
        .from('profiles')
        .update(upd)
        .eq('id', profile.id)
    }

    return json({
      users: candidates.length,
      processed: totalProcessed,
      recorded: totalRecorded,
      contacts_created: totalContactsCreated,
      token_errors: tokenErrors,
      gmail_errors: gmailErrors,
      elapsed_ms: Date.now() - runStartedAt,
    })
  } catch (e) {
    console.error('[check-inbox] fatal:', e instanceof Error ? e.message : e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// ============================================================
// Gmail 헬퍼
// ============================================================
async function fetchInboxMessageIds(
  accessToken: string,
  afterSec: number,
  maxResults: number,
): Promise<string[]> {
  const q = encodeURIComponent(`in:inbox after:${afterSec}`)
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxResults}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gmail list ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { messages?: Array<{ id: string }> }
  return (data.messages ?? []).map((m) => m.id)
}

// History API: startHistoryId 이후 INBOX 에 추가된(messageAdded) 메시지 id 델타.
// 반환 historyId 는 다음 tick 의 startHistoryId 로 저장. 404(만료)면 throw → 시간기반 폴백.
// 페이지네이션은 maxResults 한도까지만 (budget 보호). dedup 적용.
async function fetchHistoryMessageIds(
  accessToken: string,
  startHistoryId: string,
  maxResults: number,
): Promise<{ ids: string[]; historyId: string }> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  let latestHistoryId = startHistoryId
  for (let page = 0; page < 10; page++) {
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
      throw new Error(`Gmail history ${res.status}: ${body.slice(0, 150)}`)
    }
    const data = (await res.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>
      historyId?: string
      nextPageToken?: string
    }
    if (data.historyId) latestHistoryId = data.historyId
    for (const h of data.history ?? []) {
      for (const ma of h.messagesAdded ?? []) {
        const id = ma.message?.id
        if (id) ids.add(id)
      }
    }
    if (ids.size >= maxResults || !data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return { ids: Array.from(ids).slice(0, maxResults), historyId: latestHistoryId }
}

// 현재 mailbox 의 historyId — 시간기반 폴백 후 History 경로로 전환하기 위한 시드.
async function fetchCurrentHistoryId(accessToken: string): Promise<string> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Gmail getProfile ${res.status}`)
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
    throw new Error(`Gmail get ${res.status}`)
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

async function refreshGoogleToken(refreshToken: string): Promise<string> {
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
