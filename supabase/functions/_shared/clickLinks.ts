// 메일 본문 <a href> 를 track-click 리다이렉트로 감싸는 공용 헬퍼.
//
// - http/https 링크만 래핑 (mailto:/tel:/cid:/# 등은 그대로)
// - 이미 래핑된 링크(/track-click) 는 재래핑하지 않음 (재발송/포워드 안전)
// - 서명: HMAC-SHA256(`${rid|tmid}|${cid|''}|${url}`, secret) base64url 앞 22자
//   → track-click/index.ts 의 검증 로직과 반드시 동일하게 유지할 것.
//
// 사용처: send-scheduled-campaigns (개별 발송, rid+cid), process-sequences (tmid)

export interface ClickWrapTarget {
  /** 캠페인 개별 발송 — recipient id + campaign id */
  rid?: string
  cid?: string
  /** 스레드/시퀀스 발송 — thread_message id */
  tmid?: string
}

// track-click/index.ts 와 공유 — 서명 규칙이 한 곳에만 존재하도록 export.
export function buildClickPayload(target: ClickWrapTarget, url: string): string {
  return target.tmid ? `${target.tmid}||${url}` : `${target.rid}|${target.cid}|${url}`
}

// WebCrypto 키는 secret 이 같으면 isolate 수명 동안 재사용 — 발송 루프에서 링크·수신자마다
// importKey 를 다시 하던 낭비 제거 (300명 × 링크 N개 → importKey 수백 회 → 1 회).
let _keyCache: { secret: string; key: CryptoKey } | null = null
async function getSigningKey(secret: string): Promise<CryptoKey> {
  if (_keyCache?.secret === secret) return _keyCache.key
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  _keyCache = { secret, key }
  return key
}

export async function hmacSig(payload: string, secret: string): Promise<string> {
  const key = await getSigningKey(secret)
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const bytes = new Uint8Array(sigBuf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22)
}

// href 속성값의 HTML 엔티티 디코드 — TipTap/innerHTML 이 '&' 를 &amp; 로 직렬화하므로
// 디코드 없이 서명/리다이렉트하면 쿼리 파라미터가 'amp;b=2' 로 깨진다.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*38;/g, '&')
}

// 반대로 HTML 속성에 삽입할 때는 & 를 엔티티로 이스케이프 (유효한 HTML 유지)
function encodeForHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function isWrappableHref(href: string, trackBase: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  if (href.startsWith(trackBase)) return false // 이미 래핑됨
  return true
}

/**
 * html 안의 모든 http(s) 링크를 클릭 트래킹 리다이렉트로 치환.
 * secret 이 비어있으면 원본 그대로 반환 (트래킹 미설정 환경 안전).
 */
export async function wrapLinksForClickTracking(
  html: string,
  target: ClickWrapTarget,
  supabaseUrl: string,
  secret: string,
): Promise<string> {
  if (!secret) return html
  const isThread = !!target.tmid
  if (!isThread && (!target.rid || !target.cid)) return html

  const trackBase = `${supabaseUrl}/functions/v1/track-click`

  // href 수집 (중복 URL 은 서명 1회만 계산) — 속성값은 엔티티 디코드 후 서명
  const hrefRe = /(<a\b[^>]*?\bhref=)(["'])([^"']+)\2/gi
  const unique = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(html)) !== null) {
    const decoded = decodeHtmlEntities(m[3])
    if (isWrappableHref(decoded, trackBase)) unique.add(m[3]) // 원문 속성값을 키로
  }
  if (unique.size === 0) return html

  const wrapped = new Map<string, string>()
  for (const rawHref of unique) {
    const decoded = decodeHtmlEntities(rawHref)
    const sig = await hmacSig(buildClickPayload(target, decoded), secret)
    const params = new URLSearchParams(
      isThread
        ? { tmid: target.tmid!, u: decoded, s: sig }
        : { rid: target.rid!, cid: target.cid!, u: decoded, s: sig },
    )
    // HTML 속성에 다시 들어가므로 & → &amp; 이스케이프 (유효 HTML)
    wrapped.set(rawHref, encodeForHtmlAttr(`${trackBase}?${params.toString()}`))
  }

  return html.replace(hrefRe, (full, prefix, quote, href) => {
    const w = wrapped.get(href)
    if (!w) return full
    return `${prefix}${quote}${w}${quote}`
  })
}
