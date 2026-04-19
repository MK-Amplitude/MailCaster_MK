// Supabase Edge Function: resolve-company
// 입력: { raw_name: string, contact_id?: string }
// 동작: company_cache 조회 → miss 시 OpenAI 호출 → 캐시 저장 → contact row 업데이트
// 반환: { name_ko, name_en, confidence, cached }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ResolveInput {
  raw_name: string
  contact_id?: string
}

interface CompanyResult {
  name_ko: string | null
  name_en: string | null
  confidence: number
  reasoning?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { raw_name, contact_id }: ResolveInput = await req.json()
    if (!raw_name || !raw_name.trim()) {
      return json({ error: 'raw_name required' }, 400)
    }

    const query = raw_name.trim()
    const queryKey = query.toLowerCase()
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 1) 캐시 조회
    const { data: cached } = await supabase
      .schema('mailcaster')
      .from('company_cache')
      .select('*')
      .eq('query_key', queryKey)
      .maybeSingle()

    let result: CompanyResult
    let cacheHit = false

    if (cached) {
      cacheHit = true
      result = {
        name_ko: cached.name_ko,
        name_en: cached.name_en,
        confidence: Number(cached.confidence) || 0,
      }
    } else {
      // 2) OpenAI 호출
      result = await callOpenAI(query)

      // 3) 캐시 저장
      const { error: cacheErr } = await supabase
        .schema('mailcaster')
        .from('company_cache')
        .upsert(
          {
            query_text: query,
            name_ko: result.name_ko,
            name_en: result.name_en,
            confidence: result.confidence,
            source: 'openai',
            raw_response: result as unknown as Record<string, unknown>,
          },
          { onConflict: 'query_key' }
        )
      if (cacheErr) console.error('[resolve-company] cache upsert failed:', cacheErr)
    }

    // 4) contact row 업데이트
    if (contact_id) {
      const status =
        result.name_ko || result.name_en ? 'resolved' : 'not_found'
      const { error: upErr } = await supabase
        .schema('mailcaster')
        .from('contacts')
        .update({
          company_ko: result.name_ko,
          company_en: result.name_en,
          company_lookup_status: status,
          company_lookup_at: new Date().toISOString(),
        })
        .eq('id', contact_id)
      if (upErr) console.error('[resolve-company] contact update failed:', upErr)
    }

    return json({ ...result, cached: cacheHit })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[resolve-company] failed:', msg)
    return json({ error: msg }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function callOpenAI(query: string): Promise<CompanyResult> {
  const systemPrompt = `당신은 회사명 정규화 어시스턴트입니다.
사용자가 입력한 회사명, 약어, 또는 이메일 도메인을 받아 해당 회사의 공식 명칭을 한국어와 영어로 반환합니다.

규칙:
- 한국 기업: 법인 등기상 공식명(예: "주식회사 카카오", "Kakao Corp.")을 반환
- 글로벌 기업 중 한국 공식 표기가 있는 경우: 공식 표기 사용(예: "구글", "Google LLC" / "마이크로소프트", "Microsoft Corporation")
- 글로벌 기업 중 한국 공식 표기가 없는 경우: 한글 음차(외래어 표기)를 사용(예: "앰플리튜드", "Amplitude, Inc." / "노션", "Notion Labs, Inc.")
- 한국 지사가 별도 법인으로 존재하면 지사명을 우선 사용(예: "구글코리아 유한회사")
- name_ko 는 가능한 한 항상 채울 것. 공식 한국 표기가 없으면 음차라도 제공. 정말 회사를 식별할 수 없을 때만 null
- name_en 도 가능한 한 항상 채울 것
- 확신이 없으면 confidence 를 낮게 (0.3~0.6) 설정하되 값은 채울 것
- 반드시 JSON 으로만 답변. 추가 설명 금지.`

  const userPrompt = `회사명 또는 도메인: "${query}"

다음 형식으로 답변:
{"name_ko": string|null, "name_en": string|null, "confidence": 0.0~1.0}`

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
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI ${res.status}: ${body}`)
  }

  const json = await res.json()
  const content = json.choices?.[0]?.message?.content ?? '{}'
  try {
    const parsed = JSON.parse(content)
    return {
      name_ko: parsed.name_ko ?? null,
      name_en: parsed.name_en ?? null,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    }
  } catch {
    return { name_ko: null, name_en: null, confidence: 0 }
  }
}
