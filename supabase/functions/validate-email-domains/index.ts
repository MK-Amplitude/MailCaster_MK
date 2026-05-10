// Supabase Edge Function: validate-email-domains
//
// 발송 전 이메일 도메인 MX 레코드 사전 검증 — 반송 가능성 높은 도메인 사전 차단.
// 도메인 단위로 dedupe 해서 DNS 호출 횟수 최소화.
//
// 입력: { emails: string[] }  (1~5000)
// 출력: {
//   invalid_emails: string[],
//   invalid_domains: string[],
//   checked_domains: number
// }
//
// 동작:
//   1) 이메일 → 도메인 추출 + dedupe
//   2) 각 도메인 Deno.resolveDns(domain, 'MX') — 1.5s timeout
//   3) MX 레코드 0건 또는 DNS 에러 → invalid 마킹
//   4) 같은 도메인의 모든 이메일을 invalid_emails 에 누적
//
// 보안: 인증된 사용자만. 외부 노출 X (사용자가 가진 연락처 도메인만 조회).

import { z } from 'npm:zod@3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  emails: z.array(z.string()).min(1).max(5000),
})

const DNS_TIMEOUT_MS = 1500
// DNS 병렬 호출 제한 — 너무 많으면 IP 차단 위험
const PARALLEL_LIMIT = 20

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return json({ error: '로그인이 필요합니다.' }, 401)
    }

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

    // 1) 이메일에서 도메인 추출 + dedupe
    const domainToEmails = new Map<string, string[]>()
    for (const email of parsed.emails) {
      const e = email.trim().toLowerCase()
      const at = e.lastIndexOf('@')
      if (at <= 0 || at === e.length - 1) {
        // @ 없거나 잘못된 위치 — invalid
        const list = domainToEmails.get('__malformed__') ?? []
        list.push(email)
        domainToEmails.set('__malformed__', list)
        continue
      }
      const domain = e.slice(at + 1)
      const list = domainToEmails.get(domain) ?? []
      list.push(email)
      domainToEmails.set(domain, list)
    }

    const malformed = domainToEmails.get('__malformed__') ?? []
    domainToEmails.delete('__malformed__')

    const domains = Array.from(domainToEmails.keys())

    // 2) 도메인 MX 검증 (parallel, with concurrency limit)
    const invalidDomains: string[] = []
    for (let i = 0; i < domains.length; i += PARALLEL_LIMIT) {
      const batch = domains.slice(i, i + PARALLEL_LIMIT)
      const results = await Promise.all(batch.map(checkDomain))
      results.forEach((ok, idx) => {
        if (!ok) invalidDomains.push(batch[idx])
      })
    }

    // 3) invalid 도메인의 모든 이메일을 수집
    const invalidEmails: string[] = [...malformed]
    for (const d of invalidDomains) {
      const emails = domainToEmails.get(d) ?? []
      invalidEmails.push(...emails)
    }

    return json({
      invalid_emails: invalidEmails,
      invalid_domains: invalidDomains,
      malformed_count: malformed.length,
      checked_domains: domains.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[validate-emails] fatal:', msg)
    return json({ error: '서버 오류가 발생했습니다.', detail: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// 도메인 MX 검증 — true 면 valid, false 면 invalid.
// timeout 적용: 느린 DNS 응답에 함수 전체가 막히면 안 됨.
async function checkDomain(domain: string): Promise<boolean> {
  // Public suffix 만 있고 도메인 없는 경우 (e.g., "com") → invalid
  if (!domain.includes('.')) return false
  if (domain.length < 4) return false

  try {
    const records = await withTimeout(
      Deno.resolveDns(domain, 'MX'),
      DNS_TIMEOUT_MS
    )
    return Array.isArray(records) && records.length > 0
  } catch {
    // NXDOMAIN, timeout, network error → invalid
    return false
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('DNS timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}
