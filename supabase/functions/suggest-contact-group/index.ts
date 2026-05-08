// Supabase Edge Function: suggest-contact-group
// 자연어 쿼리 → AI 가 매칭되는 연락처 ID 리스트 반환.
//
// 입력: { description: string, org_id: string, max_results?: number }
// 출력: { matched_ids: string[], group_name: string, reasoning: string, total_scanned: number }
//
// 보안:
//   - Authorization: Bearer <user_jwt> 필수
//   - 해당 user 가 org_id 의 멤버인지 확인 (org_members 테이블)
//   - 매칭 결과는 동일 org 안의 contact 만 반환
//
// LLM: gpt-4o-mini (저렴) — 정확도가 부족하면 OPENAI_MODEL=gpt-4o 로 업그레이드

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
// 자연어 매칭은 의미 추론이 핵심 — 기본 gpt-4o.
// company resolver(gpt-4o-mini) 와 분리해 비용/정확도를 독립 관리한다.
// 비용이 너무 오르면 SUGGEST_GROUP_MODEL=gpt-4o-mini 로 secrets 만 변경하면 됨.
const OPENAI_MODEL =
  Deno.env.get('SUGGEST_GROUP_MODEL') ?? 'gpt-4o'

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

interface ContactSummary {
  id: string
  name: string | null
  company: string | null
  company_ko: string | null
  parent_group: string | null
  customer_type: string | null
  department: string | null
  job_title: string | null
  display_title: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Auth: user JWT 필수
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return json({ error: 'unauthorized' }, 401)
    }
    const userJwt = auth.slice('Bearer '.length)

    const body: RequestInput = await req.json()
    const description = body.description?.trim() ?? ''
    const orgId = body.org_id?.trim() ?? ''
    const maxResults = Math.min(Math.max(body.max_results ?? DEFAULT_MAX, 1), MAX_LIMIT)

    if (!description) return json({ error: 'description required' }, 400)
    if (!orgId) return json({ error: 'org_id required' }, 400)

    // 1) 사용자 식별 — JWT 를 명시적으로 getUser 에 전달 (SERVICE_ROLE 와 혼용 시
    // 인증 흐름이 꼬이는 케이스 회피).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await admin.auth.getUser(userJwt)
    if (userErr || !userData?.user?.id) {
      console.error('[suggest-contact-group] getUser failed:', userErr)
      return json({ error: 'invalid token', detail: userErr?.message }, 401)
    }
    const userId = userData.user.id

    // 2) org 멤버십 확인
    const { data: membership, error: memErr } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle()
    if (memErr) {
      console.error('[suggest-contact-group] membership check failed:', memErr)
      return json({ error: 'membership check failed', detail: memErr.message }, 500)
    }
    if (!membership) return json({ error: 'not a member of this org' }, 403)

    // 2) org 의 모든 연락처를 압축된 형태로 가져오기 (수신거부/반송 제외)
    const { data: contacts, error: contactsErr } = await admin
      .schema('mailcaster')
      .from('contacts')
      .select(
        'id, name, company, company_ko, parent_group, customer_type, department, job_title, display_title'
      )
      .eq('org_id', orgId)
      .eq('is_unsubscribed', false)
      .eq('is_bounced', false)
      .range(0, 9999)
    if (contactsErr) throw contactsErr

    const summaries: ContactSummary[] = (contacts ?? []) as ContactSummary[]
    const totalScanned = summaries.length
    if (totalScanned === 0) {
      return json({
        matched_ids: [],
        group_name: description,
        reasoning: '조직에 연락처가 없습니다.',
        total_scanned: 0,
      })
    }

    // 3) OpenAI 호출
    let result
    try {
      result = await callOpenAI(description, summaries, maxResults)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[suggest-contact-group] OpenAI call failed:', msg)
      return json({ error: 'AI 호출 실패', detail: msg }, 502)
    }

    // 4) AI 가 hallucinated 한 ID 필터 — 실제 org 의 contact 만 통과
    const validIds = new Set(summaries.map((c) => c.id))
    const matched = result.matched_ids.filter((id) => validIds.has(id))

    return json({
      matched_ids: matched.slice(0, maxResults),
      group_name: result.group_name || description.slice(0, 60),
      reasoning: result.reasoning || '',
      total_scanned: totalScanned,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[suggest-contact-group] failed:', msg)
    return json({ error: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface AIResult {
  matched_ids: string[]
  group_name: string
  reasoning: string
}

async function callOpenAI(
  description: string,
  contacts: ContactSummary[],
  maxResults: number
): Promise<AIResult> {
  const systemPrompt = `당신은 한국 B2B 영업/마케팅 데이터베이스의 컨텍스트 검색 어시스턴트입니다.
사용자가 자연어로 메일링 대상을 설명하면, 주어진 연락처 목록에서 해당하는 사람들의 id 만 추려 반환합니다.

규칙:
1) 한국 비즈니스 문맥 이해:
   - "대기업" / "그룹사" → parent_group 이 채워진 연락처 (롯데/신세계/삼성/현대/LG/SK/GS/CJ/한화/카카오/네이버/포스코/두산/효성/...).
   - "스타트업" → parent_group 이 NULL 이고 회사명이 작은 신생 기업 패턴.
   - "중견" → 그룹사 미포함이지만 규모 있는 회사 (회사명 + 직책의 임원 비율로 추정).
   - "임원" → 대표/CEO/사장/부사장/COO/CFO/CMO/CTO/CPO/CBO/CSO/이사/상무/전무/등기임원 + Director/VP/Head 영문 표기.
   - "팀장" / "리더" / "리드" → 팀장, 리드, Lead, Manager, 책임, 책임자, 매니저.
   - "실무자" / "담당" → 사원, 대리, 매니저급 이하, 담당, Engineer, Analyst.
2) 부서/직책 매칭은 부서 + 직책 + display_title 모두 살펴보기. 한 곳에라도 키워드가 있으면 후보.
   예: "마케팅" → department 또는 job_title 또는 display_title 에 "마케팅" / "Marketing" / "CMO" / "브랜드".
3) "Amplitude 고객" / "기존 고객" → customer_type='amplitude_customer'.
   "영업 대상" / "프로스펙트" → customer_type='prospect'.
4) 여러 조건이 결합되면 AND 로 좁힌다. (예: "대기업 마케팅 팀장" = 그룹사 ∩ 마케팅 키워드 ∩ 팀장 키워드)
5) 모호하면 보수적으로 매칭 — 확실한 케이스만 포함. 매칭이 없으면 빈 배열.
6) 최대 ${maxResults}명까지만 반환.
7) group_name 은 입력 description 을 짧게 정리한 한국어 (예: "대기업 마케팅 팀장").
8) reasoning 한 줄로 어떤 기준으로 매칭했는지 설명.
9) 반드시 JSON 으로만 답변.`

  // 토큰 절약을 위해 NULL 필드는 제거하고 JSON 으로 직렬화
  const compact = contacts.map((c) => {
    const o: Record<string, string> = { i: c.id }
    if (c.name) o.n = c.name
    const co = c.company_ko ?? c.company
    if (co) o.c = co
    if (c.parent_group) o.g = c.parent_group
    if (c.customer_type && c.customer_type !== 'general') o.t = c.customer_type
    if (c.department) o.d = c.department
    const title = c.display_title?.trim() || c.job_title || ''
    if (title) o.j = title
    return o
  })

  const userPrompt = `[연락처 목록] (총 ${contacts.length}명)
필드 약어: i=id, n=이름, c=회사, g=그룹사, t=고객분류, d=부서, j=직책

${JSON.stringify(compact)}

[질의]
"${description}"

다음 형식으로 답변:
{"matched_ids": [string,...], "group_name": string, "reasoning": string}`

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
  try {
    const parsed = JSON.parse(content)
    return {
      matched_ids: Array.isArray(parsed.matched_ids) ? parsed.matched_ids : [],
      group_name: typeof parsed.group_name === 'string' ? parsed.group_name : '',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  } catch {
    return { matched_ids: [], group_name: '', reasoning: '' }
  }
}
