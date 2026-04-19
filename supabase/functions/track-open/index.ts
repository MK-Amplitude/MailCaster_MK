// Supabase Edge Function: track-open
// ------------------------------------------------------------
// 이메일 본문에 삽입된 1x1 투명 GIF 픽셀이 호출되는 엔드포인트.
// GET /functions/v1/track-open?rid=<recipient_id>&cid=<campaign_id>
//
// 응답은 **항상 200 OK** + 1x1 투명 GIF (43 byte).
// 쿼리 파라미터가 이상하거나 DB 기록 실패여도 에러 응답은 돌리지 않는다 —
// 클라이언트(Gmail) 가 broken image icon 을 보여주면 프라이버시 침해 경고보다 UX 가 나빠짐.
//
// DB 기록:
//   - mailcaster.track_email_open() RPC 호출
//     → open_events 행 추가 + recipients 플래그 / 카운터 갱신 + campaigns.open_count 증가
//
// 보안 모델 (threat model):
//   이 엔드포인트는 이메일 본문에 삽입된 picture URL 이므로 익명 호출이 필수다.
//   따라서 완벽한 위조 방지는 불가능 — 아래 계층 방어를 적용한다.
//
//   1) URL 자체가 capability — rid+cid 는 UUID v4 조합 (≈2^244 엔트로피).
//      메일 외부로 새지 않으면 추측 불가능.
//   2) HTTP method 는 GET 만 허용. HEAD/POST/OPTIONS 는 pixel 반환하되 DB 미기록.
//      pre-fetcher 스캐너 (POST 로 찌르는 vulnerability scanner 등) 의 오탐 방지.
//   3) User-Agent 휴리스틱 — 실제 메일 클라이언트가 아닌 명백한 bot/crawler UA 는
//      DB 미기록 (픽셀은 여전히 반환). 완벽하진 않지만 noise 억제.
//   4) 카운터 원자성 — track_email_open RPC 의 RETURNING 패턴으로
//      campaigns.open_count 가 동일 recipient 에 대해 **최대 1회** 만 증가.
//      URL 이 새서 반복 호출되어도 recipients.open_count 만 올라가고
//      campaigns 집계는 안전 (migration 011).
//   5) pg_cron 과 달리 CRON_SECRET 검증은 없음 —
//      verify_jwt=false 로 배포 필요 (config.toml 혹은 대시보드 설정).
//
// 캐시 방지:
//   - Cache-Control: no-store, Pragma: no-cache (프록시 · Gmail 이미지 프록시의
//     반복 호출을 살리기 위해)
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// 1x1 투명 GIF (base64 "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
// 주의: 아래 Uint8Array 는 해당 GIF 의 raw bytes.
const TRANSPARENT_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01,
  0x44, 0x00, 0x3b,
])

const gifHeaders = {
  'Content-Type': 'image/gif',
  'Content-Length': String(TRANSPARENT_GIF.byteLength),
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  'Access-Control-Allow-Origin': '*',
}

function pixel() {
  return new Response(TRANSPARENT_GIF, { status: 200, headers: gifHeaders })
}

// UUID v4 형식인지 러프 검증 (DB 레벨에선 FK 에서 걸리지만 쿼리 부하 아끼기 위해)
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 명백한 bot/crawler UA — 이들은 실제 오픈이 아니므로 DB 기록 스킵.
// (완벽한 차단은 아님 — 메일 발송자에게 "오픈 집계 과장" 을 줄이는 용도)
const BOT_UA_RE =
  /(bot|crawler|spider|scanner|curl|wget|python-requests|axios|node-fetch|postman|httpclient)/i

Deno.serve(async (req) => {
  try {
    // W4) method 검증 — pixel 은 브라우저가 <img> 로 GET 만 보냄.
    //   HEAD/POST/OPTIONS 등은 vulnerability scanner 또는 prefetcher 일 가능성이 높음.
    //   응답은 픽셀로 유지해 CORS/health probe 에 대응하되 DB 기록은 하지 않음.
    if (req.method !== 'GET') {
      return pixel()
    }

    const url = new URL(req.url)
    const rid = url.searchParams.get('rid') ?? ''
    const cid = url.searchParams.get('cid') ?? ''

    if (!UUID_RE.test(rid) || !UUID_RE.test(cid)) {
      console.warn('[track-open] invalid ids', { rid, cid })
      return pixel()
    }

    // IP / UA 는 모니터링 / 중복 오픈 식별용. 없어도 OK.
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('cf-connecting-ip') ||
      null
    const ua = req.headers.get('user-agent') || null

    // W3) bot/crawler UA 는 DB 기록 스킵 (pixel 은 반환)
    if (ua && BOT_UA_RE.test(ua)) {
      return pixel()
    }

    // service_role 로 RPC 호출 — RLS 우회
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 호출은 fire-and-forget 에 가깝게 — 실패해도 픽셀은 항상 반환
    supabase
      .schema('mailcaster')
      .rpc('track_email_open', {
        p_recipient_id: rid,
        p_campaign_id: cid,
        p_ip: ip,
        p_user_agent: ua,
      })
      .then((r: { error: unknown }) => {
        if (r.error) console.warn('[track-open] rpc error:', r.error)
      })

    return pixel()
  } catch (e) {
    console.error('[track-open] fatal:', e instanceof Error ? e.message : e)
    return pixel()
  }
})
