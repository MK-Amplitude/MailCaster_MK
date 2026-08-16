// Supabase Edge Function: generate-reply-draft
//
// 받은 답장에 대한 AI 답장 초안 생성.
// 입력: {
//   org_id: string,
//   contact_id?: string,          // 히스토리 컨텍스트 조회용 (없으면 원문만으로 생성)
//   original_body: string,        // 상대 답장 본문 (plain text, 클라이언트가 태그 제거)
//   original_subject?: string,
//   tone?: 'formal' | 'friendly' | 'concise',
//   sender_name?: string,
// }
// 출력: { body_text: string, body_html: string }
//
// 보안: Authorization: Bearer <user_jwt> — auth.getUser() 검증 + org 멤버십 확인.
// contact_id 는 org 소속 검증 후에만 히스토리 조회 (IDOR 차단).
//
// 비용: gpt-4o-mini ≈ 600 input + 300 output tokens ≈ $0.0003/건.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const OPENAI_MODEL = Deno.env.get('REPLY_DRAFT_MODEL') ?? 'gpt-4o-mini'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  org_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  original_body: z.string().trim().min(1, '답장 원문이 비어 있습니다.').max(8000),
  original_subject: z.string().max(300).optional(),
  tone: z.enum(['formal', 'friendly', 'concise']).optional(),
  sender_name: z.string().max(80).optional(),
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

const TONE_DESC: Record<string, string> = {
  formal: '정중하고 격식 있는',
  friendly: '친근하고 자연스러운',
  concise: '간결하고 본질만 짚는',
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
        e instanceof z.ZodError ? e.errors[0]?.message ?? '잘못된 요청' : '요청 본문 오류'
      return json({ error: msg }, 400)
    }

    // 사용자 검증 + org 멤버십
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json({ error: '인증에 실패했습니다.' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const { data: membership } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('user_id')
      .eq('org_id', parsed.org_id)
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (!membership) return json({ error: '이 조직의 멤버가 아닙니다.' }, 403)

    // 컨텍스트 — contact 가 org 소속인 경우에만 히스토리 요약 제공
    const contextLines: string[] = []
    if (parsed.contact_id) {
      const { data: contact } = await admin
        .schema('mailcaster')
        .from('contacts')
        .select('org_id, name, company, parent_group, job_title, display_title, customer_type')
        .eq('id', parsed.contact_id)
        .maybeSingle()
      if (contact && contact.org_id === parsed.org_id) {
        if (contact.name) contextLines.push(`이름: ${String(contact.name).slice(0, 50)}`)
        if (contact.company) contextLines.push(`회사: ${String(contact.company).slice(0, 60)}`)
        if (contact.parent_group) contextLines.push(`그룹사: ${String(contact.parent_group).slice(0, 30)}`)
        const title = contact.display_title || contact.job_title
        if (title) contextLines.push(`직책: ${String(title).slice(0, 50)}`)
        if (contact.customer_type) contextLines.push(`분류: ${contact.customer_type}`)

        // 최근 발송 이력 3건 — 제목만 (본문은 토큰 낭비)
        const { data: recentOut } = await admin
          .schema('mailcaster')
          .from('thread_messages')
          .select('subject, sent_at')
          .eq('contact_id', parsed.contact_id)
          .eq('status', 'sent')
          .order('sent_at', { ascending: false })
          .limit(3)
        if (recentOut && recentOut.length > 0) {
          contextLines.push(
            `최근 발송: ${recentOut.map((t) => `"${String(t.subject ?? '').slice(0, 60)}"`).join(', ')}`,
          )
        }
      }
    }

    const toneText = parsed.tone ? TONE_DESC[parsed.tone] : '정중하고 자연스러운'
    const systemPrompt = `당신은 한국 B2B 영업 담당자의 이메일 답장을 대신 작성합니다.
상대방의 답장을 읽고, 그에 대한 우리의 답장 초안을 작성하세요.

원칙:
1) 톤: ${toneText} 한국어. 비즈니스 매너.
2) 분량: 3~8줄. 상대의 질문/요청에 구체적으로 응답.
3) 상대가 미팅/자료를 요청했으면 수락하고 다음 단계(일정 후보, 자료 전달)를 제안.
4) 상대가 거절/보류면 정중히 수용하고 부드럽게 다음 기회를 열어둠. 강압 금지.
5) 모르는 사실(가격, 일정 확정 등)은 지어내지 말고 "확인 후 회신" 으로.
6) 인사와 끝맺음 포함. 서명은 시스템이 붙이므로 이름만 간단히.
${parsed.sender_name ? `보내는 사람: ${parsed.sender_name}` : ''}

출력 형식 (반드시 JSON): {"body_text": "<답장 본문 plain text, 줄바꿈은 \\n>"}
다른 키 금지.`

    const userPrompt = [
      contextLines.length > 0 ? `[상대방 정보]\n${contextLines.join('\n')}\n` : '',
      parsed.original_subject ? `[메일 제목]\n${parsed.original_subject}\n` : '',
      `[상대방의 답장]\n"""\n${parsed.original_body}\n"""`,
      '',
      '위 답장에 대한 우리 쪽 답장 초안을 JSON 으로 작성하세요.',
    ].filter(Boolean).join('\n')

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 700,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('[reply-draft] openai error:', res.status, body.slice(0, 200))
      const friendly = /rate.?limit|429/i.test(body)
        ? 'AI 가 잠시 혼잡합니다. 잠시 후 다시 시도해주세요.'
        : 'AI 초안 생성에 실패했습니다.'
      return json({ error: friendly }, 502)
    }
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? '{}'
    let bodyText = ''
    try {
      const p = JSON.parse(content) as { body_text?: string }
      bodyText = (p.body_text ?? '').trim()
    } catch {
      return json({ error: 'AI 응답 파싱 실패' }, 502)
    }
    if (!bodyText) return json({ error: 'AI 가 빈 초안을 반환했습니다.' }, 502)

    return json({ body_text: bodyText, body_html: textToHtml(bodyText) })
  } catch (e) {
    // 내부 예외 메시지는 로그로만 — 응답에 detail 로 노출하면 스택/드라이버 정보 유출
    console.error('[reply-draft] fatal:', e instanceof Error ? e.message : String(e))
    return json({ error: '서버 오류가 발생했습니다.' }, 500)
  }
})
