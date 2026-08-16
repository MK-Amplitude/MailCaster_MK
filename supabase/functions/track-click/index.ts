// Supabase Edge Function: track-click
// ------------------------------------------------------------
// 메일 본문 링크가 이 엔드포인트로 감싸져 발송된다. 클릭 시:
//   1) HMAC 서명 검증 (발송 시점에 서버가 서명한 URL 만 통과 — open redirect 차단)
//   2) click_events 기록 + 카운터 갱신 (RPC)
//   3) 원래 URL 로 302 리다이렉트
//
// 캠페인:  GET /track-click?rid=<recipient_id>&cid=<campaign_id>&u=<url>&s=<sig>
// 스레드:  GET /track-click?tmid=<thread_message_id>&u=<url>&s=<sig>
//
// 서명: HMAC-SHA256(`${rid|tmid}|${cid|''}|${url}`, CRON_SECRET) 의 base64url 앞 22자.
//   - 발송 함수 (send-scheduled-campaigns / process-sequences) 의 wrapLinksForClickTracking
//     과 반드시 동일 알고리즘 유지.
//   - 서명이 없거나 틀리면 DB 기록 없이 원 URL 로 리다이렉트만 (http/https 한정),
//     그 외에는 400. 트래킹 실패가 수신자의 링크 이동을 막으면 안 됨.
//
// verify_jwt=false 필요 (config.toml) — 메일 클라이언트의 익명 GET.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 봇/스캐너 UA — 기록 스킵 (리다이렉트는 수행). track-open 과 동일 목록.
const BOT_UA_RE =
  /(bot|crawler|spider|scanner|curl|wget|python-requests|axios|node-fetch|postman|httpclient)/i

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  })
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400 })
}

// http/https 만 리다이렉트 허용 — javascript:/data: 등 차단
function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function hmacSig(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CRON_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const bytes = new Uint8Array(sigBuf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22)
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'GET') return badRequest('GET only')

    const url = new URL(req.url)
    const rid = url.searchParams.get('rid') ?? ''
    const cid = url.searchParams.get('cid') ?? ''
    const tmid = url.searchParams.get('tmid') ?? ''
    const target = url.searchParams.get('u') ?? ''
    const sig = url.searchParams.get('s') ?? ''

    if (!target || !isSafeHttpUrl(target)) return badRequest('invalid url')

    const isThread = !!tmid
    const idOk = isThread
      ? UUID_RE.test(tmid)
      : UUID_RE.test(rid) && UUID_RE.test(cid)

    // 서명 검증 — 발송 시점 서버가 만든 링크만 기록.
    // 서명 불일치/누락은 기록 없이 리다이렉트만 (수신자 이동은 항상 보장).
    let verified = false
    if (idOk && sig && CRON_SECRET) {
      const payload = isThread ? `${tmid}||${target}` : `${rid}|${cid}|${target}`
      const expected = await hmacSig(payload)
      // 고정 길이 문자열이라 timing 차이는 실질 위험 없음 (22자 base64url)
      verified = sig === expected
    }

    if (!verified) {
      return redirect(target)
    }

    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('cf-connecting-ip') ||
      null
    const ua = req.headers.get('user-agent') || null

    // 봇 UA 는 기록 스킵 — 링크 프리페처가 클릭 집계를 오염시키는 것 방지
    if (ua && BOT_UA_RE.test(ua)) {
      return redirect(target)
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 기록은 await — 리다이렉트 응답 후 isolate 회수로 유실되지 않게 (track-open 과 동일 정책)
    if (isThread) {
      const r = await supabase.schema('mailcaster').rpc('track_thread_click', {
        p_thread_message_id: tmid,
        p_url: target,
        p_ip: ip,
        p_user_agent: ua,
      })
      if (r.error) console.warn('[track-click] thread rpc error:', r.error)
    } else {
      const r = await supabase.schema('mailcaster').rpc('track_email_click', {
        p_recipient_id: rid,
        p_campaign_id: cid,
        p_url: target,
        p_ip: ip,
        p_user_agent: ua,
      })
      if (r.error) console.warn('[track-click] rpc error:', r.error)
    }

    return redirect(target)
  } catch (e) {
    console.error('[track-click] fatal:', e instanceof Error ? e.message : e)
    // 오류가 나도 목적지 이동은 보장 — u 파라미터가 안전하면 리다이렉트
    try {
      const target = new URL(req.url).searchParams.get('u') ?? ''
      if (isSafeHttpUrl(target)) return redirect(target)
    } catch { /* fall through */ }
    return badRequest('error')
  }
})
