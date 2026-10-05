// Supabase Edge Function: unsubscribe
// ------------------------------------------------------------
// 캠페인 메일의 수신거부 (정보통신망법 제50조 / RFC 8058 one-click) 공개 엔드포인트.
//
//   GET|HEAD /functions/v1/unsubscribe?t=<token>
//        → 302 ${APP_BASE_URL}/unsubscribe?t=<token> (GitHub Pages SPA 확인 페이지).
//          **GET 으로는 절대 수신거부하지 않는다** — 기업 메일 보안 게이트웨이/링크 스캐너가
//          본문 링크를 미리 GET 하므로 GET 처리 시 받는 사람도 모르게 수신거부가 등록된다.
//          (Supabase 기본 도메인 *.supabase.co 는 text/html 을 text/plain 으로 바꿔 보내므로
//           사람이 보는 페이지는 이 함수가 아니라 SPA 가 렌더링한다.)
//   POST (application/json) body {"t":"<token>", "preview":true}
//        → SPA 확인 페이지 진입 시 미리보기 — **수신거부하지 않음** (unsubscribe_token_info, 080).
//          JSON {ok:true, found, email_masked, already}. 알 수 없는 토큰은
//          {ok:true, found:false, email_masked:null, already:false}.
//   POST (application/json) body {"t":"<token>"}
//        → SPA 확인 페이지의 버튼. JSON {ok:true, email_masked, already} 응답
//          (알 수 없는 토큰도 같은 {ok:true} — email_masked/already 만 빠짐, 중립 응답).
//          형식이 틀린 토큰 400 {ok:false,error:'invalid_token'}, 기록/조회 실패 503 {ok:false,error:'temporary'}.
//   POST ?t=<token> body 'List-Unsubscribe=One-Click' (RFC 8058, urlencoded/multipart)
//        → 메일 클라이언트 원클릭. 200 text/plain 'ok'.
//
// 보안 모델:
//   - 토큰(UUID v4, 122bit) 자체가 capability. 메일 밖으로 새지 않으면 추측 불가.
//   - DB 접근은 service_role 로 unsubscribe_by_token(쓰기, 079/080) / unsubscribe_token_info
//     (읽기 전용 미리보기, 080) RPC 둘뿐 — anon 은 076 에서 전면 회수.
//     토큰 매핑은 unsubscribe_tokens(080) 에 보존돼 캠페인 삭제 후에도 링크가 동작한다.
//   - CORS 는 SPA origin(APP_BASE_URL 의 origin, https://mk-amplitude.github.io)과
//     로컬 개발(localhost/127.0.0.1) 만 허용. one-click 은 메일 서버 → 서버 요청이라 CORS 무관.
//   - verify_jwt=false 로 배포 (config.toml) — 메일 클라이언트/브라우저는 JWT 가 없음.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APP_BASE_URL = (
  (Deno.env.get('APP_BASE_URL') ?? '').trim() || 'https://mk-amplitude.github.io/MailCaster_MK'
).replace(/\/+$/, '')

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// JSON 본문 상한 — {"t":"<uuid>"} 는 50바이트 남짓
const MAX_BODY_BYTES = 4096

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
}

function appOrigin(): string | null {
  try {
    return new URL(APP_BASE_URL).origin
  } catch {
    return null
  }
}
const APP_ORIGIN = appOrigin()
const DEFAULT_APP_ORIGIN = 'https://mk-amplitude.github.io'
const LOCAL_DEV_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false
  return origin === DEFAULT_APP_ORIGIN || origin === APP_ORIGIN || LOCAL_DEV_ORIGIN_RE.test(origin)
}

// 허용 origin 일 때만 CORS 헤더 — 그 외 origin 의 브라우저는 응답을 읽을 수 없다.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const base: Record<string, string> = { Vary: 'Origin' }
  if (!isAllowedOrigin(origin)) return base
  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // x-client-info — supabase-js functions.invoke 가 자동으로 붙이는 헤더
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Max-Age': '86400',
  }
}

function json(req: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

function plain(req: Request, text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

function confirmPageUrl(token: string | null): string {
  const target = `${APP_BASE_URL}/unsubscribe`
  return token ? `${target}?t=${encodeURIComponent(token)}` : target
}

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}

type RecordResult =
  | { ok: true; emailMasked: string | null; already: boolean | null }
  | { ok: false }

async function recordUnsubscribe(token: string, source: 'link' | 'one_click'): Promise<RecordResult> {
  try {
    const { data, error } = await serviceClient()
      .schema('mailcaster')
      .rpc('unsubscribe_by_token', { p_token: token, p_source: source })
    if (error) {
      console.error('[unsubscribe] rpc error:', error.message)
      return { ok: false }
    }
    const res = (data ?? {}) as { ok?: boolean; email_masked?: string; already?: boolean }
    // 알 수 없는 토큰(res.ok=false)도 호출자에겐 성공 — email_masked/already 만 없음
    const known = res.ok === true
    return {
      ok: true,
      emailMasked: known && typeof res.email_masked === 'string' ? res.email_masked : null,
      already: known && typeof res.already === 'boolean' ? res.already : null,
    }
  } catch (e) {
    console.error('[unsubscribe] fatal:', e instanceof Error ? e.message : e)
    return { ok: false }
  }
}

type PreviewResult =
  | { ok: true; found: boolean; emailMasked: string | null; already: boolean }
  | { ok: false }

// 미리보기 — 읽기 전용 RPC 만 호출. 절대 수신거부를 기록하지 않는다.
async function previewToken(token: string): Promise<PreviewResult> {
  try {
    const { data, error } = await serviceClient()
      .schema('mailcaster')
      .rpc('unsubscribe_token_info', { p_token: token })
    if (error) {
      console.error('[unsubscribe] preview rpc error:', error.message)
      return { ok: false }
    }
    const res = (data ?? {}) as { found?: boolean; email_masked?: string; already?: boolean }
    const found = res.found === true
    return {
      ok: true,
      found,
      emailMasked: found && typeof res.email_masked === 'string' ? res.email_masked : null,
      already: found && res.already === true,
    }
  } catch (e) {
    console.error('[unsubscribe] preview fatal:', e instanceof Error ? e.message : e)
    return { ok: false }
  }
}

// 본문 읽기 — 상한 초과 시 null
async function readBodyText(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await req.text()
  return text.length > MAX_BODY_BYTES ? null : text
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const queryToken = (url.searchParams.get('t') ?? '').trim()

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders(req) } })
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    // 확인은 SPA 페이지에서 — 형식이 틀린 토큰은 넘기지 않음 (SPA 가 안내 문구 표시)
    return new Response(null, {
      status: 302,
      headers: {
        ...SECURITY_HEADERS,
        Location: confirmPageUrl(UUID_RE.test(queryToken) ? queryToken : null),
      },
    })
  }

  if (req.method !== 'POST') {
    return plain(req, 'Method Not Allowed', 405)
  }

  const contentType = (req.headers.get('Content-Type') ?? '').toLowerCase()

  // RFC 8058 one-click — multipart/form-data 는 formData() 로 파싱
  if (contentType.includes('multipart/form-data')) {
    let oneClick = false
    try {
      const form = await req.formData()
      oneClick = form.get('List-Unsubscribe') === 'One-Click'
    } catch {
      // 형식 불일치 — 아래에서 400
    }
    return handleOneClick(req, queryToken, oneClick)
  }

  let bodyText: string | null
  try {
    bodyText = await readBodyText(req)
  } catch {
    bodyText = null
  }
  if (bodyText === null) {
    return contentType.includes('application/json')
      ? json(req, { ok: false, error: 'invalid_request' }, 400)
      : plain(req, 'Bad Request', 400)
  }

  // SPA 확인 페이지 — JSON {"t": "<token>"} (수신거부) / {"t": "<token>", "preview": true} (미리보기)
  const looksJson = contentType.includes('application/json') || bodyText.trimStart().startsWith('{')
  if (looksJson) {
    let bodyToken = ''
    let preview = false
    try {
      const parsed = JSON.parse(bodyText) as unknown
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as { t?: unknown; preview?: unknown }
        if (typeof obj.t === 'string') bodyToken = obj.t.trim()
        // 정확히 true 일 때만 미리보기 — 그 외 값은 기존 동작(수신거부)
        preview = obj.preview === true
      }
    } catch {
      return json(req, { ok: false, error: 'invalid_request' }, 400)
    }
    const token = bodyToken || queryToken
    if (!UUID_RE.test(token)) {
      return json(req, { ok: false, error: 'invalid_token' }, 400)
    }

    if (preview) {
      const info = await previewToken(token)
      if (!info.ok) return json(req, { ok: false, error: 'temporary' }, 503)
      return json(req, {
        ok: true,
        found: info.found,
        email_masked: info.emailMasked,
        already: info.already,
      })
    }

    const res = await recordUnsubscribe(token, 'link')
    if (!res.ok) {
      // 기록 실패를 완료로 보이면 안 됨 — SPA 가 재시도 안내
      return json(req, { ok: false, error: 'temporary' }, 503)
    }
    if (!res.emailMasked) return json(req, { ok: true })
    return json(req, {
      ok: true,
      email_masked: res.emailMasked,
      ...(res.already === null ? {} : { already: res.already }),
    })
  }

  // RFC 8058 one-click — application/x-www-form-urlencoded (Content-Type 누락도 같은 형식으로 해석)
  const oneClick = new URLSearchParams(bodyText).get('List-Unsubscribe') === 'One-Click'
  return handleOneClick(req, queryToken, oneClick)
})

async function handleOneClick(req: Request, token: string, oneClick: boolean): Promise<Response> {
  // RFC 8058 — 'List-Unsubscribe=One-Click' 본문이 있는 POST 만 수신거부로 인정
  if (!oneClick) return plain(req, 'Bad Request', 400)
  // 형식이 틀린 토큰도 존재 여부 비노출 — 같은 'ok'
  if (!UUID_RE.test(token)) return plain(req, 'ok')
  const res = await recordUnsubscribe(token, 'one_click')
  // 기록 실패 시 5xx — 메일 클라이언트가 재시도
  if (!res.ok) return plain(req, 'Temporary error', 503)
  return plain(req, 'ok')
}
