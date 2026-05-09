// Supabase Edge Function: suggest-contact-group
//
// 자연어 → 구조화된 필터 → Postgres 가 직접 매칭.
// 연락처 수와 무관하게 LLM 토큰 사용량이 일정 (요청당 ~1.2k tokens).
//
// 입력: { description: string, org_id: string, max_results?: number }
// 출력: { matched_ids: string[], group_name: string, reasoning: string, total_scanned: number }
//
// 보안:
//   - Authorization: Bearer <user_jwt> 필수
//   - org_members 검증 후 admin client 로 contacts 조회
//
// 흐름:
//   1) AI: description → FilterSpec (JSON)
//   2) DB: FilterSpec → SQL ILIKE/IN/NOT NULL 조합으로 matched_ids 조회

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
// 필터 스펙 추출은 구조화된 작업이라 mini 로 충분 — 비용/정확도 균형.
// 정확도 이슈 발생 시 secrets 에서 SUGGEST_GROUP_MODEL=gpt-4o 로 올리면 됨.
const OPENAI_MODEL = Deno.env.get('SUGGEST_GROUP_MODEL') ?? 'gpt-4o-mini'

const DEFAULT_MAX = 200
const MAX_LIMIT = 1000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface RequestInput {
  description: string
  org_id: string
  max_results?: number
}

// AI 가 반환하는 구조화된 필터 — 자연어를 SQL-friendly 한 키워드로 분해.
interface FilterSpec {
  customer_types?: string[]
  parent_groups?: string[]
  parent_group_required?: boolean
  parent_group_excluded?: boolean
  companies?: string[]
  department_keywords?: string[]
  title_keywords?: string[]
  level?: 'executive' | 'manager' | 'staff'
  group_name?: string
  reasoning?: string
}

// 직급 키워드 사전 — AI 가 level 만 결정하고, 실제 매칭 키워드는 서버에서 결정.
// 키워드 정확도/일관성을 코드로 통제하기 위해 AI 에 위임하지 않음.
const LEVEL_KEYWORDS: Record<NonNullable<FilterSpec['level']>, string[]> = {
  executive: [
    '대표', 'CEO', '사장', '부사장', 'COO', 'CFO', 'CMO', 'CTO', 'CPO',
    'CBO', 'CSO', 'CIO', '이사', '상무', '전무', '회장', '의장',
    'Director', 'VP', 'Head', 'Chief', 'President',
  ],
  manager: ['팀장', '리드', 'Lead', 'Manager', '매니저', '책임'],
  staff: [
    '사원', '대리', '담당', 'Engineer', 'Analyst', 'Associate',
    'Specialist', '연구원', '주임',
  ],
}

const VALID_CUSTOMER_TYPES = new Set([
  'amplitude_customer', 'prospect', 'partner', 'vendor', 'relationship', 'general',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return json({ error: '로그인이 필요합니다.' }, 401)
    }

    const body: RequestInput = await req.json()
    const description = body.description?.trim() ?? ''
    const orgId = body.org_id?.trim() ?? ''
    const maxResults = Math.min(Math.max(body.max_results ?? DEFAULT_MAX, 1), MAX_LIMIT)

    if (!description) return json({ error: '대상 설명을 입력해주세요.' }, 400)
    if (!orgId) return json({ error: '조직 정보가 없습니다.' }, 400)

    // 1) 사용자 식별
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) {
      console.error('[suggest-contact-group] getUser failed:', userErr)
      return json({ error: '인증에 실패했습니다. 다시 로그인해주세요.' }, 401)
    }
    const userId = userData.user.id

    // 2) admin 으로 멤버십 확인 + contacts 조회 (RLS 우회)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    const { data: membership, error: memErr } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle()
    if (memErr) {
      console.error('[suggest-contact-group] membership check failed:', memErr)
      return json({ error: '권한 확인에 실패했습니다.' }, 500)
    }
    if (!membership) return json({ error: '이 조직의 멤버가 아닙니다.' }, 403)

    // 3) org 컨텍스트 조회 — AI 에게 후보 parent_group 목록을 컨텍스트로 제공.
    //    (있는 그룹사만 골라야 의미 있음)
    const { data: pgRows } = await admin
      .schema('mailcaster')
      .from('contacts')
      .select('parent_group')
      .eq('org_id', orgId)
      .not('parent_group', 'is', null)
      .limit(2000)
    const parentGroups = Array.from(
      new Set((pgRows ?? []).map((r) => r.parent_group as string).filter(Boolean))
    ).sort()

    // 4) AI: 자연어 → FilterSpec
    let filter: FilterSpec
    try {
      filter = await aiGenerateFilter(description, parentGroups)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[suggest-contact-group] AI filter generation failed:', msg)
      const friendly = /rate.?limit|429|quota|tpm/i.test(msg)
        ? 'AI 분석이 잠시 혼잡합니다. 1분 후 다시 시도해주세요.'
        : 'AI 분석에 실패했습니다. 잠시 후 다시 시도해주세요.'
      return json({ error: friendly, detail: msg }, 502)
    }

    // 5) 조직 전체 활성 연락처 수 (UI 표시용)
    const { count: totalScanned } = await admin
      .schema('mailcaster')
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('is_unsubscribed', false)
      .eq('is_bounced', false)

    // 6) 필터 적용 → matched_ids
    let matchedIds: string[]
    try {
      matchedIds = await applyFilter(admin, orgId, filter, maxResults)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[suggest-contact-group] filter execution failed:', msg)
      return json({ error: '연락처 조회에 실패했습니다.', detail: msg }, 500)
    }

    return json({
      matched_ids: matchedIds,
      group_name: (filter.group_name || '').trim() || description.slice(0, 60),
      reasoning: (filter.reasoning || '').trim() || buildAutoReasoning(filter),
      total_scanned: totalScanned ?? 0,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[suggest-contact-group] failed:', msg)
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
// AI: description → FilterSpec
// ─────────────────────────────────────────────────────────────────────────────

async function aiGenerateFilter(
  description: string,
  parentGroups: string[]
): Promise<FilterSpec> {
  const systemPrompt = `당신은 한국 B2B 영업/마케팅 데이터베이스의 자연어 쿼리 → 구조화된 필터 변환기입니다.
사용자의 한국어 설명을 받으면 아래 JSON 스키마에 맞게 필터만 반환하세요.

[출력 스키마]
{
  "customer_types"?: string[],         // ${[...VALID_CUSTOMER_TYPES].join(' | ')}
  "parent_groups"?: string[],          // 그룹사 부분 일치 키워드 (예: "삼성", "카카오")
  "parent_group_required"?: boolean,   // "대기업"/"그룹사" → true
  "parent_group_excluded"?: boolean,   // "스타트업" → true (parent_group IS NULL)
  "companies"?: string[],              // 명시 회사명 (예: "토스", "쿠팡")
  "department_keywords"?: string[],    // 부서 키워드 (예: "마케팅", "Marketing")
  "title_keywords"?: string[],         // 직책 키워드 (예: "데이터", "PM")
  "level"?: "executive"|"manager"|"staff",
  "group_name": string,                // 짧은 한국어 그룹명 (예: "대기업 마케팅 팀장")
  "reasoning": string                  // 매칭 기준 한 줄
}

[규칙]
1) "임원/리더십" → level="executive". "팀장/리드/매니저" → "manager". "실무자/담당/사원" → "staff".
2) "대기업/그룹사" → parent_group_required=true. "스타트업/중소" → parent_group_excluded=true.
3) "Amplitude 고객/기존 고객" → customer_types=["amplitude_customer"].
   "잠재 고객/프로스펙트/영업 대상" → customer_types=["prospect"].
   "파트너" → customer_types=["partner"]. "협력/벤더" → customer_types=["vendor"].
4) 그룹명이 명시되면 parent_groups 에 짧은 키워드로 (예: "삼성 그룹" → "삼성").
   회사명이 명시되면 companies 에.
5) 부서·직무가 언급되면 department_keywords 와 title_keywords 둘 다 채워라
   (부서/직책 어디에 적혔어도 매칭되도록).
   예: "마케팅 팀장" → department_keywords=["마케팅","Marketing","브랜드"], title_keywords=["마케팅"]
6) level 의 직급 키워드는 시스템이 자체 보유 — title_keywords 에 직급 키워드를 넣지 마라.
7) 조건이 모호하면 보수적으로 빈 필드로 둬라. group_name 과 reasoning 은 항상 채워라.
8) JSON 외 다른 출력 금지.

[조직 컨텍스트]
- 이 조직에 존재하는 parent_group 후보: ${parentGroups.length ? parentGroups.join(', ') : '(없음)'}
- 조직에 없는 parent_group 은 사용하지 마라.`

  const userPrompt = `자연어 쿼리: "${description}"\n\n위 스키마로 JSON 만 반환하세요.`

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
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(content) as Partial<FilterSpec>

  // 화이트리스트 + sanitize
  const customer_types = (parsed.customer_types ?? [])
    .filter((t): t is string => typeof t === 'string')
    .filter((t) => VALID_CUSTOMER_TYPES.has(t))

  return {
    customer_types: customer_types.length ? customer_types : undefined,
    parent_groups: cleanStringArray(parsed.parent_groups),
    parent_group_required: parsed.parent_group_required === true,
    parent_group_excluded: parsed.parent_group_excluded === true,
    companies: cleanStringArray(parsed.companies),
    department_keywords: cleanStringArray(parsed.department_keywords),
    title_keywords: cleanStringArray(parsed.title_keywords),
    level:
      parsed.level === 'executive' || parsed.level === 'manager' || parsed.level === 'staff'
        ? parsed.level
        : undefined,
    group_name: typeof parsed.group_name === 'string' ? parsed.group_name : '',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  }
}

function cleanStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const arr = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length < 100)
  return arr.length ? Array.from(new Set(arr)) : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: FilterSpec → matched_ids
// ─────────────────────────────────────────────────────────────────────────────

async function applyFilter(
  admin: SupabaseClient,
  orgId: string,
  filter: FilterSpec,
  maxResults: number
): Promise<string[]> {
  let q = admin
    .schema('mailcaster')
    .from('contacts')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_unsubscribed', false)
    .eq('is_bounced', false)

  if (filter.customer_types?.length) {
    q = q.in('customer_type', filter.customer_types)
  }
  if (filter.parent_group_excluded) {
    q = q.is('parent_group', null)
  } else if (filter.parent_group_required) {
    q = q.not('parent_group', 'is', null)
  }
  if (filter.parent_groups?.length) {
    const clauses = filter.parent_groups
      .map((g) => `parent_group.ilike.%${escapeOr(g)}%`)
      .join(',')
    q = q.or(clauses)
  }
  if (filter.companies?.length) {
    const clauses = filter.companies
      .flatMap((c) => [
        `company.ilike.%${escapeOr(c)}%`,
        `company_ko.ilike.%${escapeOr(c)}%`,
      ])
      .join(',')
    q = q.or(clauses)
  }
  // 부서 키워드: department/job_title/display_title 어디든 매칭 (.or() 한 번 = 한 OR 그룹)
  if (filter.department_keywords?.length) {
    const clauses = filter.department_keywords
      .flatMap((k) => [
        `department.ilike.%${escapeOr(k)}%`,
        `job_title.ilike.%${escapeOr(k)}%`,
        `display_title.ilike.%${escapeOr(k)}%`,
      ])
      .join(',')
    q = q.or(clauses)
  }
  // 직책 키워드 + level 키워드 = 별도 OR 그룹 (부서 OR 그룹과 AND 결합)
  const titleAlt = [
    ...(filter.title_keywords ?? []),
    ...(filter.level ? LEVEL_KEYWORDS[filter.level] : []),
  ]
  if (titleAlt.length) {
    const clauses = titleAlt
      .flatMap((k) => [
        `job_title.ilike.%${escapeOr(k)}%`,
        `display_title.ilike.%${escapeOr(k)}%`,
      ])
      .join(',')
    q = q.or(clauses)
  }

  q = q.limit(maxResults)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((r) => (r as { id: string }).id)
}

// Supabase .or() 의 값은 콤마로 구분되고 () 가 그룹핑이라 사용자 입력에서 제거.
function escapeOr(s: string): string {
  return s.replace(/[(),]/g, '').trim()
}

function buildAutoReasoning(f: FilterSpec): string {
  const parts: string[] = []
  if (f.parent_group_required) parts.push('대기업·그룹사')
  if (f.parent_group_excluded) parts.push('비그룹사')
  if (f.parent_groups?.length) parts.push(`그룹: ${f.parent_groups.join('·')}`)
  if (f.companies?.length) parts.push(`회사: ${f.companies.join('·')}`)
  if (f.customer_types?.length) parts.push(`고객분류: ${f.customer_types.join('·')}`)
  if (f.level) parts.push({ executive: '임원', manager: '팀장급', staff: '실무자' }[f.level])
  if (f.department_keywords?.length) parts.push(`부서: ${f.department_keywords.join('·')}`)
  if (f.title_keywords?.length) parts.push(`직책: ${f.title_keywords.join('·')}`)
  return parts.join(' / ') || '전체 매칭'
}
