// Supabase Edge Function: resolve-pending-companies
// pg_cron 이 매일 호출하는 batch worker.
//
// 대상: company_lookup_status IN ('pending', 'failed') 이고
//       (company_lookup_at 이 NULL 이거나 retry_hours 전에 시도된 것)
// 동작: 청크 단위로 company_cache 확인 → miss 면 OpenAI 호출 → 캐시 upsert → contact 업데이트
// 보안: Authorization: Bearer <CRON_SECRET> 헤더 필수 (pg_cron 이 주입)
//
// 주의:
//  - 'not_found' 는 이미 OpenAI 가 "모른다" 고 답한 케이스 → 자동 재시도 대상 아님 (사용자 수동).
//  - 'skipped' 는 company_raw 가 비어 있던 케이스 → 대상 아님.
//  - 'resolved' 는 손대지 않음 (idempotent).

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini'
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const DEFAULT_CHUNK = 50
const MAX_CHUNK = 200
const DEFAULT_RETRY_HOURS = 24
const OPENAI_DELAY_MS = 200 // rate-limit 버퍼

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CompanyResult {
  name_ko: string | null
  name_en: string | null
  confidence: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Auth: Bearer <CRON_SECRET>
  if (!CRON_SECRET) {
    return json({ error: 'CRON_SECRET not configured on server' }, 500)
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    // 파라미터 (cron 기본값 / 필요 시 수동 호출 시 오버라이드)
    const url = new URL(req.url)
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') ?? String(DEFAULT_CHUNK), 10) || DEFAULT_CHUNK, 1),
      MAX_CHUNK
    )
    const retryHours =
      Math.max(parseInt(url.searchParams.get('retry_hours') ?? String(DEFAULT_RETRY_HOURS), 10) || DEFAULT_RETRY_HOURS, 0)

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 재시도 대상 조회
    const cutoffIso = new Date(Date.now() - retryHours * 3600_000).toISOString()
    const { data: pending, error: selErr } = await supabase
      .schema('mailcaster')
      .from('contacts')
      .select('id, company, company_raw, company_lookup_at')
      .in('company_lookup_status', ['pending', 'failed'])
      .or(`company_lookup_at.is.null,company_lookup_at.lt.${cutoffIso}`)
      .not('company_raw', 'is', null)
      .limit(limit)

    if (selErr) throw selErr

    if (!pending || pending.length === 0) {
      return json({ processed: 0, resolved: 0, not_found: 0, failed: 0, cached: 0, message: 'no pending contacts' })
    }

    let resolved = 0
    let notFound = 0
    let failed = 0
    let cachedHits = 0

    for (const c of pending) {
      const rawName = (c.company_raw ?? c.company ?? '').toString().trim()
      if (!rawName) {
        // company_raw 가 공백이면 skip 처리해서 다음 cron 에서 다시 집지 않게
        await supabase
          .schema('mailcaster')
          .from('contacts')
          .update({
            company_lookup_status: 'skipped',
            company_lookup_at: new Date().toISOString(),
          })
          .eq('id', c.id)
        continue
      }

      const queryKey = rawName.toLowerCase()

      try {
        // 1) 캐시 조회
        const { data: cacheRow } = await supabase
          .schema('mailcaster')
          .from('company_cache')
          .select('name_ko, name_en, confidence')
          .eq('query_key', queryKey)
          .maybeSingle()

        let result: CompanyResult
        if (cacheRow) {
          cachedHits++
          result = {
            name_ko: cacheRow.name_ko,
            name_en: cacheRow.name_en,
            confidence: Number(cacheRow.confidence) || 0,
          }
        } else {
          // 2) OpenAI 호출
          result = await callOpenAI(rawName)

          // 3) 캐시 upsert (다른 contact 가 같은 회사명이면 재호출 안 하도록)
          const { error: cacheErr } = await supabase
            .schema('mailcaster')
            .from('company_cache')
            .upsert(
              {
                query_text: rawName,
                name_ko: result.name_ko,
                name_en: result.name_en,
                confidence: result.confidence,
                source: 'openai',
                raw_response: result as unknown as Record<string, unknown>,
              },
              { onConflict: 'query_key' }
            )
          if (cacheErr) console.error('[resolve-batch] cache upsert failed:', cacheErr)

          // 4) rate-limit 버퍼 (OpenAI 호출한 경우에만)
          await sleep(OPENAI_DELAY_MS)
        }

        // 5) contact 업데이트
        const status = result.name_ko || result.name_en ? 'resolved' : 'not_found'
        const { error: upErr } = await supabase
          .schema('mailcaster')
          .from('contacts')
          .update({
            company_ko: result.name_ko,
            company_en: result.name_en,
            company_lookup_status: status,
            company_lookup_at: new Date().toISOString(),
          })
          .eq('id', c.id)
        if (upErr) throw upErr

        if (status === 'resolved') resolved++
        else notFound++
      } catch (e) {
        failed++
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[resolve-batch] contact ${c.id} failed:`, msg)
        // 다음 cron 에서 다시 집도록 failed 상태 + 시각 기록
        await supabase
          .schema('mailcaster')
          .from('contacts')
          .update({
            company_lookup_status: 'failed',
            company_lookup_at: new Date().toISOString(),
          })
          .eq('id', c.id)
      }
    }

    const summary = {
      processed: pending.length,
      resolved,
      not_found: notFound,
      failed,
      cached: cachedHits,
    }
    console.log('[resolve-pending-companies] done:', summary)
    return json(summary)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[resolve-pending-companies] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content ?? '{}'
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
