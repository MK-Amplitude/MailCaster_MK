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
  email_domain?: string
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
    const { raw_name, contact_id, email_domain }: ResolveInput = await req.json()
    if (!raw_name || !raw_name.trim()) {
      return json({ error: 'raw_name required' }, 400)
    }

    const query = raw_name.trim()
    const queryKey = query.toLowerCase()
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 도메인 힌트 결정 — 클라이언트가 명시적으로 보낸 값 우선.
    // 값이 없고 contact_id 가 있으면 DB 에서 email 조회해 도메인 추출.
    let domainHint = normalizeDomain(email_domain)
    if (!domainHint && contact_id) {
      const { data: contactRow } = await supabase
        .schema('mailcaster')
        .from('contacts')
        .select('email')
        .eq('id', contact_id)
        .maybeSingle()
      if (contactRow?.email) {
        domainHint = extractDomain(contactRow.email)
      }
    }

    // 1) 캐시 조회 — 과거에 저장된 null 결과는 cache miss 로 취급해
    //    도메인 힌트와 함께 다시 시도한다.
    const { data: cached } = await supabase
      .schema('mailcaster')
      .from('company_cache')
      .select('*')
      .eq('query_key', queryKey)
      .maybeSingle()

    const hasUsefulCache = cached && (cached.name_ko || cached.name_en)

    let result: CompanyResult
    let cacheHit = false

    if (hasUsefulCache) {
      cacheHit = true
      result = {
        name_ko: cached.name_ko,
        name_en: cached.name_en,
        confidence: Number(cached.confidence) || 0,
      }
    } else {
      // 2) OpenAI 호출 — 도메인을 힌트로 전달
      result = await callOpenAI(query, domainHint)

      // 3) 캐시 저장 — 유용한 결과일 때만 (null 결과 저장은 cache pollution)
      if (result.name_ko || result.name_en) {
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

// 개인/범용 메일 도메인 — 회사 식별에 도움이 되지 않으므로 힌트에서 제외
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'naver.com',
  'hanmail.net',
  'daum.net',
  'nate.com',
  'yahoo.com',
  'yahoo.co.kr',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'me.com',
  'kakao.com',
  'protonmail.com',
  'proton.me',
])

function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const parts = email.toString().trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[1]) return null
  const domain = parts[1]
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null
  return domain
}

function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  const domain = raw.toString().trim().toLowerCase()
  if (!domain) return null
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null
  return domain
}

async function callOpenAI(
  query: string,
  emailDomain: string | null
): Promise<CompanyResult> {
  const systemPrompt = `당신은 회사명 정규화 어시스턴트입니다.
사용자가 입력한 회사명/약어/브랜드명과 함께 이메일 도메인 힌트가 제공되면, 도메인으로 먼저 모기업/그룹을 식별하고 입력 이름이 그 그룹의 자회사·브랜드·부서인지 판단해 답변하세요.

규칙:
1) 도메인 우선 식별: 이메일 도메인이 제공되면 먼저 도메인 소유 기업(모기업/그룹)을 식별합니다.
2) 자회사/브랜드 매핑: 입력 이름이 도메인 소유 기업의 자회사·브랜드·사업부 등으로 보이면, 해당 자회사/브랜드의 정식 명칭을 반환합니다.
   - 예: raw="Secta9ine" + domain="spc.co.kr" → "섹타나인" (SPC 그룹 자회사)
   - 예: raw="E-LANDFASHION" + domain="eland.co.kr" → "이랜드패션" (이랜드 계열)
   - 예: raw="SCOP" + domain="sooplive.com" → "SOOP" (구 아프리카TV)
   - 예: raw="PTKOREA" + domain="cheilpengtai.com" → "제일펑타이 코리아"
3) 공식 명칭 규칙:
   - 한국 기업: 법인 등기상 공식명(예: "주식회사 카카오", "Kakao Corp.")
   - 글로벌 + 한국 공식 표기 있음: 공식 표기(예: "구글", "Google LLC" / "마이크로소프트", "Microsoft Corporation")
   - 글로벌 + 한국 공식 표기 없음: 한글 음차(예: "앰플리튜드", "Amplitude, Inc." / "노션", "Notion Labs, Inc.")
   - 한국 지사가 별도 법인으로 존재하면 지사명 우선(예: "구글코리아 유한회사")
4) name_ko 는 가능한 한 항상 채우세요. 공식 한국 표기가 없으면 음차라도 제공. 정말 식별 불가일 때만 null.
5) name_en 도 가능한 한 항상 채우세요.
6) 도메인 힌트가 "없음" 이면 이름만으로 판단합니다. (개인 메일 도메인은 이미 서버에서 제거된 상태)
7) 확신이 낮으면 confidence 를 0.3~0.6 으로 설정하되 값은 반드시 채우세요.
8) 반드시 JSON 으로만 답변. 추가 설명 금지.`

  const domainLine = emailDomain
    ? `이메일 도메인 힌트: "${emailDomain}"`
    : `이메일 도메인 힌트: 없음`

  const userPrompt = `회사명 또는 도메인: "${query}"
${domainLine}

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
