// Supabase Edge Function: generate-personalized-bodies
//
// 입력: { contact_ids: string[], intent: string, org_id: string, tone?: string,
//         signature_html?: string, sender_name?: string }
// 출력: {
//   results: Array<{
//     contact_id: string
//     name: string | null
//     email: string
//     subject: string
//     body_html: string
//   }>
// }
//
// 도메인: 오프라인 영업의 정기 터치 / 개인화 안부·후속 메일 자동 작성.
// "휴면된 Amplitude 고객 5명에게 안부" 같은 intent 를 받아 사람마다 컨텍스트
// (이름·회사·그룹사·고객분류·마지막 발송·답장 카테고리)에 맞춘 본문을 LLM 으로 생성.
//
// 보안:
//   - Authorization: Bearer <user_jwt>
//   - 사용자가 org_id 의 멤버인지 확인
//   - contact_ids 는 해당 org 의 contacts 만 통과
//
// 비용 (gpt-4o-mini 기준): contact 1명 ≈ 350 input + 250 output tokens ≈ $0.0002.
// 5명 batch ≈ $0.001. 50명 ≈ $0.01.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const OPENAI_MODEL = Deno.env.get('PERSONALIZE_MODEL') ?? 'gpt-4o-mini'

const MAX_CONTACTS_PER_CALL = 50
const PARALLEL_LIMIT = 5

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  contact_ids: z
    .array(z.string().uuid())
    .min(1, '연락처를 1명 이상 선택해주세요.')
    .max(MAX_CONTACTS_PER_CALL, `한 번에 최대 ${MAX_CONTACTS_PER_CALL}명까지 생성합니다.`),
  intent: z
    .string()
    .trim()
    .min(2, '어떤 메일을 보낼지 짧게라도 적어주세요.')
    .max(500),
  org_id: z.string().uuid(),
  tone: z.enum(['formal', 'friendly', 'concise']).optional(),
  signature_html: z.string().max(5000).optional(),
  sender_name: z.string().max(80).optional(),
})

type RequestInput = z.infer<typeof RequestSchema>

interface ContactContext {
  id: string
  name: string | null
  email: string
  company: string | null
  parent_group: string | null
  customer_type: string | null
  job_title: string | null
  display_title: string | null
  last_sent_at: string | null
  last_replied_at: string | null
  reply_count: number
  last_campaign_name: string | null
  last_reply_category: string | null
}

interface GenerationResult {
  contact_id: string
  name: string | null
  email: string
  subject: string
  body_html: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return json({ error: '로그인이 필요합니다.' }, 401)
    }

    let parsed: RequestInput
    try {
      const raw = await req.json()
      parsed = RequestSchema.parse(raw)
    } catch (e) {
      const msg =
        e instanceof z.ZodError
          ? e.errors[0]?.message ?? '잘못된 요청입니다.'
          : '요청 본문을 읽을 수 없습니다.'
      return json({ error: msg }, 400)
    }

    // 사용자 식별
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json({ error: '인증에 실패했습니다.' }, 401)
    }
    const userId = userData.user.id

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // org 멤버십 확인
    const { data: membership } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('user_id')
      .eq('org_id', parsed.org_id)
      .eq('user_id', userId)
      .maybeSingle()
    if (!membership) return json({ error: '이 조직의 멤버가 아닙니다.' }, 403)

    // 컨텍스트 일괄 조회 — contact_engagement view 사용
    const contexts = await fetchContexts(admin, parsed.org_id, parsed.contact_ids)
    if (contexts.length === 0) {
      return json({ error: '대상 연락처를 찾을 수 없습니다.' }, 404)
    }

    // 병렬 생성 (PARALLEL_LIMIT 만큼씩)
    const results: GenerationResult[] = []
    const errors: Array<{ contact_id: string; error: string }> = []
    for (let i = 0; i < contexts.length; i += PARALLEL_LIMIT) {
      const batch = contexts.slice(i, i + PARALLEL_LIMIT)
      const settled = await Promise.allSettled(
        batch.map((c) =>
          generateOne(c, parsed.intent, parsed.tone, parsed.signature_html, parsed.sender_name)
        )
      )
      settled.forEach((s, idx) => {
        const c = batch[idx]
        if (s.status === 'fulfilled') {
          results.push(s.value)
        } else {
          const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
          console.error('[personalize] one failed', c.id, msg)
          errors.push({ contact_id: c.id, error: msg })
          // fallback — context 만 채운 plain 본문
          results.push(fallbackResult(c, parsed.intent))
        }
      })
    }

    return json({ results, errors })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[personalize] fatal:', msg)
    return json({ error: '서버 오류가 발생했습니다.', detail: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Context fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchContexts(
  admin: SupabaseClient,
  orgId: string,
  contactIds: string[]
): Promise<ContactContext[]> {
  // contact_engagement view 가 last_campaign JSONB 까지 다 가져옴.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = admin as any
  const { data, error } = await sb
    .from('contact_engagement')
    .select(
      'id, name, email, company, parent_group, customer_type, job_title, display_title, last_sent_at, last_replied_at, reply_count, last_campaign'
    )
    .eq('org_id', orgId)
    .in('id', contactIds)
  if (error) throw error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    company: r.company,
    parent_group: r.parent_group,
    customer_type: r.customer_type,
    job_title: r.job_title,
    display_title: r.display_title,
    last_sent_at: r.last_sent_at,
    last_replied_at: r.last_replied_at,
    reply_count: r.reply_count ?? 0,
    last_campaign_name: r.last_campaign?.campaign_name ?? null,
    last_reply_category: r.last_campaign?.reply_category ?? null,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────────────────────

const TONE_DESC: Record<NonNullable<RequestInput['tone']>, string> = {
  formal: '정중하고 격식 있는',
  friendly: '친근하고 자연스러운',
  concise: '간결하고 본질만 짚는',
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400_000)
}

function buildSystemPrompt(tone?: RequestInput['tone'], senderName?: string): string {
  const toneText = tone ? TONE_DESC[tone] : '자연스럽고 정중한'
  const sender = senderName ? `보내는 사람 이름: ${senderName}` : ''
  return `당신은 한국 B2B 영업/마케팅 담당자가 보내는 개인화 메일을 작성합니다.
도메인: 오프라인 영업의 정기 터치 — 메일은 관계 유지 보조 채널.

작성 원칙:
1) 톤: ${toneText} 한국어. 비즈니스 매너 유지.
2) 분량: 본문 4~10줄. 짧고 명료.
3) 변수 치환 ({{name}} 같은) 금지 — 이미 사람별 컨텍스트로 직접 작성.
4) 인사말은 "${'${sender}'.length > 0 ? '간단히' : '자연스럽게'}" — 회사명/그룹사를 활용해 진정성.
5) 끝맺음은 답장 유도 또는 미팅/통화 제안. 강압적 X.
6) 주제·이름·회사를 어색하게 반복하지 않는다.
${sender}

출력 형식 (반드시 JSON):
{"subject": "<짧은 한국어 제목>", "body_text": "<본문 plain text. 줄바꿈은 \\\\n>"}
- subject: 50자 이하, 구체적
- body_text: HTML 변환은 시스템에서 처리. 일반 줄바꿈만.
- 다른 키 추가 금지.`
}

function buildUserPrompt(c: ContactContext, intent: string): string {
  const days = daysSince(c.last_sent_at)
  const replyDays = daysSince(c.last_replied_at)
  const lines: string[] = []
  lines.push(`[받는 사람 컨텍스트]`)
  lines.push(`이름: ${c.name ?? '(이름 미상)'}`)
  if (c.parent_group) lines.push(`그룹사: ${c.parent_group}`)
  if (c.company) lines.push(`회사: ${c.company}`)
  if (c.display_title || c.job_title) lines.push(`직책: ${c.display_title || c.job_title}`)
  if (c.customer_type) lines.push(`분류: ${c.customer_type}`)
  if (days !== null) lines.push(`마지막 메일 발송: ${days}일 전`)
  if (c.last_campaign_name) lines.push(`마지막 캠페인: "${c.last_campaign_name}"`)
  if (c.reply_count > 0) lines.push(`이전 답장 횟수: ${c.reply_count}`)
  if (c.last_reply_category) lines.push(`마지막 답장 톤: ${c.last_reply_category}`)
  if (replyDays !== null) lines.push(`마지막 답장: ${replyDays}일 전`)
  lines.push(``)
  lines.push(`[발신자 의도]`)
  lines.push(intent)
  lines.push(``)
  lines.push('위 컨텍스트를 자연스럽게 녹여 개인화된 메일을 JSON 으로 작성하세요.')
  return lines.join('\n')
}

async function generateOne(
  c: ContactContext,
  intent: string,
  tone?: RequestInput['tone'],
  signatureHtml?: string,
  senderName?: string
): Promise<GenerationResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(tone, senderName) },
        { role: 'user', content: buildUserPrompt(c, intent) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 600,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  let parsed: { subject?: string; body_text?: string } = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('LLM JSON 파싱 실패')
  }
  const subject = (parsed.subject ?? '').trim().slice(0, 100) || '안녕하세요'
  const text = (parsed.body_text ?? '').trim() || '안녕하세요.'
  const body_html = textToHtml(text) + (signatureHtml ? `\n<br>${signatureHtml}` : '')
  return {
    contact_id: c.id,
    name: c.name,
    email: c.email,
    subject,
    body_html,
  }
}

function fallbackResult(c: ContactContext, intent: string): GenerationResult {
  // LLM 실패 시 최소한의 본문 — 사용자가 review 단계에서 수정 가능.
  const greeting = c.name ? `${c.name}님,` : '안녕하세요,'
  const body = `${greeting}\n\n${intent}\n\n감사합니다.`
  return {
    contact_id: c.id,
    name: c.name,
    email: c.email,
    subject: '안녕하세요',
    body_html: textToHtml(body),
  }
}

function textToHtml(text: string): string {
  // plain text → 안전한 HTML. <p> 단락 + <br> 줄바꿈.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return paragraphs
}
