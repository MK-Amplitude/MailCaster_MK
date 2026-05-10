// Supabase Edge Function: ocr-business-card
//
// 명함 사진 → name/email/phone/company/parent_group/job_title/department 추출 (GPT-4o vision).
// 사용자가 ContactsPage 에서 사진 업로드 → 자동 추출 → ContactFormDialog 에 prefill.
//
// 입력: { image_data_url: string }  (data:image/png;base64,... 형식)
// 출력: { fields: { name?, email?, phone?, company?, parent_group?, job_title?, department? } }
//
// 비용 (gpt-4o, vision):
//   1024×1024 이미지 ≈ 765 input tokens × $0.0025/1K ≈ $0.002/건
//   100건/일 ≈ $0.2/일

import { z } from 'npm:zod@3'

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const OPENAI_MODEL = Deno.env.get('OCR_MODEL') ?? 'gpt-4o'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  image_data_url: z
    .string()
    .startsWith('data:image/', '이미지 형식이 올바르지 않습니다.')
    .max(15_000_000, '이미지가 너무 큽니다 (최대 ~10MB).'),
})

interface ExtractedFields {
  name?: string
  email?: string
  phone?: string
  company?: string
  parent_group?: string
  job_title?: string
  department?: string
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

    const fields = await extractFromImage(parsed.image_data_url)
    return json({ fields })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[ocr] fatal:', msg)
    return json({ error: '명함 인식에 실패했습니다.', detail: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function extractFromImage(dataUrl: string): Promise<ExtractedFields> {
  const systemPrompt = `당신은 한국·영문 명함 OCR 전문가입니다. 사진에서 다음 필드를 추출해 JSON 으로만 응답하세요.

[추출 필드]
- name           : 이름 (한국어 우선, 영문 fallback)
- email          : 첫 번째 비즈니스 이메일
- phone          : 휴대폰 또는 사무실 번호 (숫자/-/공백)
- company        : 회사 공식 명칭 (한국어). 영문 회사명만 있으면 영문 그대로.
- parent_group   : 그룹사·모회사 (예: "삼성", "롯데", "신세계", "카카오"). 명시되어 있을 때만.
- job_title      : 직책 (예: "팀장", "이사", "Senior Engineer"). 부서는 제외.
- department     : 소속 부서 (예: "마케팅 1팀", "Product Marketing").

[규칙]
1) 텍스트가 흐릿/일부 가려지면 추측하지 말고 해당 필드 생략.
2) 여러 이메일·전화가 있으면 가장 비즈니스 컨텍스트에 맞는 1개.
3) JSON 외 다른 출력 금지. 미발견 필드는 키 자체를 생략.
4) 잡스러운 quote/줄바꿈 제거된 문자열로.`

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
        {
          role: 'user',
          content: [
            { type: 'text', text: '아래 명함에서 필드를 추출하세요.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 400,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  let parsed: ExtractedFields
  try {
    parsed = JSON.parse(content)
  } catch {
    return {}
  }
  // 화이트리스트 + sanitize
  return {
    name: cleanString(parsed.name),
    email: cleanString(parsed.email)?.toLowerCase(),
    phone: cleanString(parsed.phone),
    company: cleanString(parsed.company),
    parent_group: cleanString(parsed.parent_group),
    job_title: cleanString(parsed.job_title),
    department: cleanString(parsed.department),
  }
}

function cleanString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().replace(/\s+/g, ' ')
  if (!t || t.length > 200) return undefined
  return t
}
