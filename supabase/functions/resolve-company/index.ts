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
  // 입력 raw_name 에 부서명이 섞여 들어온 경우 (예: "삼성전자 마케팅팀") 분리.
  // raw_name 에 부서가 없으면 null.
  extracted_department: string | null
  confidence: number
  reasoning?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { raw_name, contact_id, email_domain }: ResolveInput = await req.json()
    // raw_name 또는 email_domain (또는 contact_id 로부터 도메인 추출 가능) 중 하나는 필수.
    // 도메인 단독 모드 — 회사명 없이 이메일 도메인만으로 그룹사 추론.
    const hasRawName = raw_name && raw_name.trim().length > 0
    const hasDomainHint = email_domain && email_domain.trim().length > 0
    if (!hasRawName && !hasDomainHint && !contact_id) {
      return json({ error: 'raw_name, email_domain 또는 contact_id 중 하나는 필요합니다.' }, 400)
    }

    // raw_name 이 없으면 도메인 자체를 query 로 사용 (캐시 키는 도메인).
    // 둘 다 있으면 raw_name 우선.
    const query = hasRawName ? raw_name!.trim() : (email_domain ?? '').trim()
    const queryKey = (hasRawName ? raw_name! : query).toLowerCase()
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
      // 캐시에 raw_response 가 있으면 extracted_department 도 복원 (이전 호출 결과 유지).
      const cachedRaw = (cached.raw_response ?? {}) as Record<string, unknown>
      const cachedExtractedDept =
        typeof cachedRaw.extracted_department === 'string'
          ? (cachedRaw.extracted_department as string)
          : null
      result = {
        name_ko: cached.name_ko,
        name_en: cached.name_en,
        parent_group: cached.parent_group ?? null,
        extracted_department: cachedExtractedDept,
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

      // 부서 채우기 — 사용자가 직접 입력한 부서가 있으면 덮어쓰지 않음.
      // 기존 department 가 NULL/공백일 때만 AI 가 분리한 값으로 채움.
      // company / company_raw 도 동일 정책: raw_name 에서 부서를 떼어낸 본문이 있으면
      // company_raw 를 정리된 회사명으로 (사용자가 보는 입력 필드) 갱신해 일관성 유지.
      const updates: Record<string, unknown> = {
        company_ko: result.name_ko,
        company_en: result.name_en,
        parent_group: result.parent_group,
        company_lookup_status: status,
        company_lookup_at: new Date().toISOString(),
      }

      if (result.extracted_department) {
        const { data: existing } = await supabase
          .schema('mailcaster')
          .from('contacts')
          .select('department, company, company_raw')
          .eq('id', contact_id)
          .maybeSingle()

        // 기존 department 가 비어있으면 분리된 부서로 채움
        if (existing && (!existing.department || !existing.department.trim())) {
          updates.department = result.extracted_department
        }

        // company / company_raw 도 회사명만 남기도록 정리 (사용자 입력 필드 일관성).
        // 단, 사용자가 이미 깔끔한 값으로 수정한 경우 (raw_name 과 다른 경우) 보존.
        // raw_name 에서 부서를 제거한 회사명 부분을 추출 — query 의 시작 부분과 일치하면 정리.
        const trimmedCompany = stripDepartmentFromRaw(query, result.extracted_department)
        if (trimmedCompany && existing?.company === query) {
          updates.company = trimmedCompany
          updates.company_raw = trimmedCompany
        }
      }

      const { error: upErr } = await supabase
        .schema('mailcaster')
        .from('contacts')
        .update(updates)
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
사용자가 입력한 회사명/약어/브랜드명과 (옵션) 이메일 도메인을 받아, 다음 5가지를 JSON 으로 반환합니다:
  - name_ko: 한글 정식 명칭
  - name_en: 영문 정식 명칭
  - parent_group: 한국 대기업 그룹사 한글명 (자회사인 경우만, 독립 기업은 null)
  - extracted_department: 입력에 부서명이 섞여 있으면 분리 (없으면 null)
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
7) extracted_department — 입력에 회사명 + 부서가 함께 들어있는 경우 분리:
   - 예: raw="삼성전자 마케팅팀" → name_ko="삼성전자", extracted_department="마케팅팀"
   - 예: raw="LG화학 연구소 신소재팀" → name_ko="LG화학", extracted_department="연구소 신소재팀"
   - 예: raw="CJ ENM 콘텐츠전략국 글로벌사업팀" → name_ko="CJ ENM", extracted_department="콘텐츠전략국 글로벌사업팀"
   - 부서 식별 단서: "팀/실/본부/국/센터/사업부/연구소/연구원/Lab/Office/Division/Group/Department" 등.
   - 회사명만 있으면 extracted_department=null.
   - 회사+직책 ("삼성전자 팀장") 인 경우: 직책은 부서가 아님 → extracted_department=null
     (직책은 별도 필드라 회사명 정규화 책임 아님)
   - 그룹사명 자체 ("롯데", "삼성") 는 부서가 아님.
8) 반드시 JSON 으로만 답변. 추가 설명 금지.`

  // 도메인 단독 모드 (회사명 없이) — query 와 emailDomain 이 같음. 프롬프트에 도메인만 주어진 케이스 명시.
  const isDomainOnly = !!emailDomain && query.toLowerCase() === emailDomain.toLowerCase()
  const domainLine = emailDomain
    ? `이메일 도메인 힌트: "${emailDomain}"`
    : `이메일 도메인 힌트: 없음`

  const userPrompt = isDomainOnly
    ? `회사명 입력은 없습니다. 아래 이메일 도메인만으로 소유 기업과 그룹사를 추론하세요:
${domainLine}

다음 형식으로 답변:
{"name_ko": string|null, "name_en": string|null, "parent_group": string|null, "extracted_department": null, "confidence": 0.0~1.0}`
    : `회사명 또는 도메인: "${query}"
${domainLine}

다음 형식으로 답변:
{"name_ko": string|null, "name_en": string|null, "parent_group": string|null, "extracted_department": string|null, "confidence": 0.0~1.0}`

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
      extracted_department: cleanDept(parsed.extracted_department),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    }
  } catch {
    return {
      name_ko: null,
      name_en: null,
      parent_group: null,
      extracted_department: null,
      confidence: 0,
    }
  }
}

function cleanDept(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > 100) return null
  return t
}

// raw_name 에서 분리된 부서를 떼어내고 회사명 부분만 반환.
// 단순 정책: raw 끝부분이 dept 와 일치하면 잘라냄. 매칭 안 되면 null (보존).
function stripDepartmentFromRaw(raw: string, dept: string): string | null {
  const r = raw.trim()
  const d = dept.trim()
  if (!r || !d) return null
  // 끝부분이 dept 와 일치하는지 (공백/특수문자 무시하고)
  const lower = r.toLowerCase()
  const dLower = d.toLowerCase()
  if (lower.endsWith(dLower)) {
    const head = r.slice(0, r.length - d.length).trim()
    // 회사명이 너무 짧아지면 (1자 이하) 의심 → null 반환해 보존
    if (head.length < 2) return null
    return head
  }
  return null
}
