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
  parent_group: string | null
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
        parent_group: cached.parent_group ?? null,
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
              parent_group: result.parent_group,
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
          parent_group: result.parent_group,
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
  const systemPrompt = `당신은 한국 기업 정보 어시스턴트입니다.
사용자가 입력한 회사명/약어/브랜드명과 (옵션) 이메일 도메인을 받아, 다음 4가지를 JSON 으로 반환합니다:
  - name_ko: 한글 정식 명칭
  - name_en: 영문 정식 명칭
  - parent_group: 한국 대기업 그룹사 한글명 (자회사인 경우만, 독립 기업은 null)
  - confidence: 0.0~1.0

규칙:
1) 도메인 우선 식별: 이메일 도메인이 제공되면 먼저 도메인 소유 기업(모기업/그룹)을 식별합니다.
2) 자회사/브랜드 매핑: 입력 이름이 도메인 소유 기업의 자회사·브랜드·사업부 등으로 보이면, 해당 자회사/브랜드의 정식 명칭을 반환합니다.
   - 예: raw="Secta9ine" + domain="spc.co.kr" → name_ko="섹타나인", parent_group="SPC"
   - 예: raw="E-LANDFASHION" + domain="eland.co.kr" → name_ko="이랜드패션", parent_group="이랜드"
   - 예: raw="SCOP" + domain="sooplive.com" → name_ko="SOOP" (독립 기업, parent_group=null)
3) 공식 명칭:
   - 한국 기업: 법인 등기상 공식명(예: "주식회사 카카오", "Kakao Corp.")
   - 글로벌 + 한국 공식 표기 있음: 공식 표기(예: "구글", "Google LLC")
   - 글로벌 + 한국 공식 표기 없음: 한글 음차(예: "앰플리튜드", "Amplitude, Inc.")
   - 한국 지사 별도 법인 존재: 지사명 우선(예: "구글코리아 유한회사")
4) parent_group (그룹사) — 한국 대기업 그룹사의 자회사인 경우만 채움. 한글로 짧게.
   - 알려진 그룹사: 롯데, 신세계, 삼성, 현대, LG, SK, GS, 한화, CJ, 카카오, 네이버, 두산, 코오롱, 효성, 포스코, 농심, 오리온, 현대백화점, 미래에셋, 골프존, 이랜드, SPC, 하림, 빙그레, 종근당, 한미약품, 셀트리온, 넥슨, 엔씨소프트, 넷마블, 크래프톤, NHN, 야놀자, 우아한형제들, 등
   - 매핑 예시:
       "롯데캐피탈" → parent_group="롯데"
       "신세계라이브쇼핑" / "이마트" / "SSG.COM" / "스타벅스코리아" → parent_group="신세계"
       "CJ제일제당" / "CJ ENM" / "CJ올리브영" → parent_group="CJ"
       "GS리테일" / "GS칼텍스" → parent_group="GS"
       "SK텔레콤" / "SK하이닉스" / "SK D&D" / "SK렌터카" → parent_group="SK"
       "카카오엔터테인먼트" / "카카오스타일" / "카카오헬스케어" → parent_group="카카오"
       "골프존카운티" / "골프존커머스" → parent_group="골프존"
       "삼성전자" / "삼성SDS" → parent_group="삼성"
       "현대자동차" / "현대건설" / "기아" → parent_group="현대"
   - 독립 스타트업 / 그룹 미소속 / 식별 불가 → parent_group=null
   - 글로벌 본사 (Google, Microsoft 등) → parent_group=null (한국 그룹사 아니므로)
5) 도메인 힌트가 "없음" 이면 이름만으로 판단. (개인 메일 도메인은 서버에서 이미 제거됨.)
6) name_ko 는 가능한 한 항상 채우세요. name_en 도. 확신이 낮으면 confidence=0.3~0.6 로.
7) 반드시 JSON 으로만 답변. 추가 설명 금지.`

  const domainLine = emailDomain
    ? `이메일 도메인 힌트: "${emailDomain}"`
    : `이메일 도메인 힌트: 없음`

  const userPrompt = `회사명 또는 도메인: "${query}"
${domainLine}

다음 형식으로 답변:
{"name_ko": string|null, "name_en": string|null, "parent_group": string|null, "confidence": 0.0~1.0}`

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
      parent_group: parsed.parent_group ?? null,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    }
  } catch {
    return { name_ko: null, name_en: null, parent_group: null, confidence: 0 }
  }
}
