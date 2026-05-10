// Supabase Edge Function: classify-existing-replies
//
// 028 (reply_category) 도입 이전에 도착한 답장 — 또는 분류 시점 예산 부족으로
// 'unclear' 로 저장된 답장 — 을 일괄 백필 분류한다.
//
// 트리거:
//   - 사용자 직접 버튼 (CampaignDetailPage 의 "이전 답장 분류")
//   - org 전체 또는 단일 캠페인 범위 지원
//
// 입력: {
//   org_id: string
//   campaign_id?: string   // 지정 시 그 캠페인만, 없으면 org 전체
//   limit?: number         // 한 번에 처리 max (기본 50, 최대 200)
//   include_unclear?: boolean  // 'unclear' 도 재분류 대상에 포함 (기본 false)
// }
//
// 출력: { processed, classified, errors, remaining }
//
// 동작:
//   1) auth 검증 + org 멤버십
//   2) replied=true AND reply_category IS NULL (또는 'unclear') AND
//      gmail_thread_id NOT NULL 인 recipients 조회
//   3) user_id 별 그룹핑 → google_refresh_token → access_token
//   4) 각 recipient: thread.get → messages.get → classify → update
//
// 비용 (gpt-4o-mini): 1건 ≈ 60 토큰 ≈ $0.000008.
//   답장 1만건 백필 ≈ $0.08. 합리적.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const OPENAI_CLASSIFY_MODEL =
  Deno.env.get('REPLY_CLASSIFY_MODEL') ?? 'gpt-4o-mini'

const RUN_BUDGET_MS = 50_000
const PER_RECIPIENT_BUDGET_MS = 3_000
const REPLY_BODY_MAX_CHARS = 2000
const MAX_LIMIT = 200

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  org_id: z.string().uuid(),
  campaign_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  include_unclear: z.boolean().optional(),
})

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

interface Row {
  id: string
  campaign_id: string
  gmail_thread_id: string
  sent_at: string | null
  reply_category: ReplyCategory | null
  campaigns: { user_id: string } | { user_id: string }[] | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401)

    let parsed: z.infer<typeof RequestSchema>
    try {
      parsed = RequestSchema.parse(await req.json())
    } catch (e) {
      const msg =
        e instanceof z.ZodError
          ? e.errors[0]?.message ?? '잘못된 요청'
          : '요청 본문을 읽을 수 없습니다.'
      return json({ error: msg }, 400)
    }

    // 사용자 식별
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json({ error: '인증 실패' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // org 멤버십 확인
    const { data: membership } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('user_id')
      .eq('org_id', parsed.org_id)
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (!membership) return json({ error: '이 조직의 멤버가 아닙니다.' }, 403)

    const limit = parsed.limit ?? 50
    const runStartedAt = Date.now()

    // 백필 대상 — replied=true && (NULL 또는 'unclear') && thread_id 존재
    let q = admin
      .schema('mailcaster')
      .from('recipients')
      .select(
        'id, campaign_id, gmail_thread_id, sent_at, reply_category, campaigns!inner(user_id, org_id)'
      )
      .eq('replied', true)
      .not('gmail_thread_id', 'is', null)
      .eq('campaigns.org_id', parsed.org_id)
      .order('replied_at', { ascending: false, nullsFirst: false })
      .limit(limit)

    if (parsed.campaign_id) {
      q = q.eq('campaign_id', parsed.campaign_id)
    }

    const { data: rowsRaw, error: qErr } = await q
    if (qErr) throw qErr
    let rows = (rowsRaw ?? []) as Row[]

    // null 또는 (옵션) 'unclear' 만 처리
    rows = rows.filter((r) => {
      if (r.reply_category === null) return true
      if (parsed.include_unclear && r.reply_category === 'unclear') return true
      return false
    })

    if (rows.length === 0) {
      return json({ processed: 0, classified: 0, errors: 0, remaining: 0 })
    }

    // user_id 별 access_token 1번
    const byUser = new Map<string, Row[]>()
    for (const r of rows) {
      const uid = userIdOf(r)
      if (!uid) continue
      if (!byUser.has(uid)) byUser.set(uid, [])
      byUser.get(uid)!.push(r)
    }

    let processed = 0
    let classified = 0
    let errors = 0

    userLoop: for (const [userId, list] of byUser) {
      if (Date.now() - runStartedAt > RUN_BUDGET_MS - PER_RECIPIENT_BUDGET_MS) break

      const { data: profile } = await admin
        .schema('mailcaster')
        .from('profiles')
        .select('email, google_refresh_token')
        .eq('id', userId)
        .single()
      if (!profile?.google_refresh_token || !profile?.email) {
        // 토큰 없는 사용자는 skip — UI 에 그대로 노출됨
        continue
      }

      let accessToken: string
      try {
        accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
      } catch (e) {
        console.warn('[backfill] token refresh failed uid=', userId, e)
        continue
      }

      const userEmailLower = (profile.email as string).toLowerCase()

      for (const r of list) {
        if (Date.now() - runStartedAt > RUN_BUDGET_MS - PER_RECIPIENT_BUDGET_MS) break userLoop
        processed++
        try {
          // thread 의 가장 이른 "타인" 메시지를 찾아 본문 가져오기
          const messageId = await findReplyMessageId(accessToken, r, userEmailLower)
          if (!messageId) {
            // thread 가 삭제됐거나 답장 메시지를 못 찾음 — 'unclear' 로 마킹
            await admin
              .schema('mailcaster')
              .from('recipients')
              .update({ reply_category: 'unclear' })
              .eq('id', r.id)
            classified++
            continue
          }
          const category = await classifyReply(accessToken, messageId)
          const { error: uErr } = await admin
            .schema('mailcaster')
            .from('recipients')
            .update({ reply_category: category })
            .eq('id', r.id)
          if (uErr) {
            errors++
            console.warn('[backfill] update fail rid=', r.id, uErr.message)
          } else {
            classified++
          }
        } catch (e) {
          errors++
          console.warn(
            '[backfill] error rid=',
            r.id,
            e instanceof Error ? e.message : e
          )
        }
      }
    }

    // 남은 후보 추정 — 이번 batch limit 보다 많이 있었다면 다음 호출 필요
    const remaining = rows.length - processed
    return json({
      processed,
      classified,
      errors,
      remaining: Math.max(0, remaining),
    })
  } catch (e) {
    console.error('[backfill] fatal:', e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

function userIdOf(r: Row): string | null {
  const c = r.campaigns
  if (!c) return null
  if (Array.isArray(c)) return c[0]?.user_id ?? null
  return c.user_id ?? null
}

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail / OpenAI helpers — check-replies 와 동일 로직
// ─────────────────────────────────────────────────────────────────────────────

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
    throw new Error(`Google OAuth ${res.status}: ${body}`)
  }
  const j = await res.json()
  if (!j.access_token) throw new Error('no access_token')
  return j.access_token as string
}

async function findReplyMessageId(
  accessToken: string,
  r: Row,
  userEmailLower: string
): Promise<string | null> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(r.gmail_thread_id)}` +
    `?format=metadata&metadataHeaders=From`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    if (res.status === 404) return null
    throw new Error(`threads.get ${res.status}`)
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
  let earliest: { ms: number; messageId: string } | null = null
  for (const m of messages) {
    const ts = Number(m.internalDate ?? 0)
    if (!ts || ts <= sentAtMs) continue
    const from = extractFromHeader(m.payload?.headers)
    if (!from) continue
    if (from.toLowerCase() === userEmailLower) continue
    if (earliest === null || ts < earliest.ms) earliest = { ms: ts, messageId: m.id }
  }
  return earliest?.messageId ?? null
}

function extractFromHeader(
  headers?: Array<{ name: string; value: string }>
): string | null {
  if (!headers) return null
  const h = headers.find((x) => x.name.toLowerCase() === 'from')
  if (!h) return null
  const angle = /<([^>]+)>/.exec(h.value)
  if (angle?.[1]) return angle[1].trim()
  const noComment = h.value.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  const m = /[^\s<>]+@[^\s<>]+/.exec(noComment)
  return m ? m[0].trim() : noComment || null
}

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
  if (!res.ok) throw new Error(`OpenAI ${res.status}`)
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

async function fetchReplyBody(
  accessToken: string,
  messageId: string
): Promise<string> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`messages.get ${res.status}`)
  const msg = (await res.json()) as { payload?: GmailPart }
  return extractTextBody(msg.payload) ?? ''
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

function extractTextBody(part?: GmailPart): string | null {
  if (!part) return null
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data)
  if (part.parts && part.parts.length > 0) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data)
    }
    for (const p of part.parts) {
      const nested = extractTextBody(p)
      if (nested) return nested
    }
    for (const p of part.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) return stripHtml(decodeBase64Url(p.body.data))
    }
  }
  if (part.mimeType === 'text/html' && part.body?.data) return stripHtml(decodeBase64Url(part.body.data))
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

function stripQuotedAndSignature(text: string): string {
  const replyHeaderPatterns = [
    /\n\s*On .+ wrote:[\s\S]*$/m,
    /\n\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[\s\S]+(작성|wrote|쓴 글|보낸 메일):[\s\S]*$/m,
    /\n\s*-+\s*Original Message\s*-+[\s\S]*$/im,
    /\n\s*From:.+\nSent:.+[\s\S]*$/im,
  ]
  let out = text
  for (const re of replyHeaderPatterns) out = out.replace(re, '')
  out = out.replace(/\n--\s*\n[\s\S]*$/m, '')
  out = out
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
  return out.trim()
}

// 사용 안 하는 reference 막기 (Deno tsc 경고)
type _Admin = SupabaseClient
void {} as unknown as _Admin
