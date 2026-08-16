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

async function hmacSig(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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

  // href 수집 (중복 URL 은 서명 1회만 계산)
  const hrefRe = /(<a\b[^>]*?\bhref=)(["'])([^"']+)\2/gi
  const unique = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = hrefRe.exec(html)) !== null) {
    if (isWrappableHref(m[3], trackBase)) unique.add(m[3])
  }
  if (unique.size === 0) return html

  const wrapped = new Map<string, string>()
  for (const href of unique) {
    const payload = isThread
      ? `${target.tmid}||${href}`
      : `${target.rid}|${target.cid}|${href}`
    const sig = await hmacSig(payload, secret)
    const params = new URLSearchParams(
      isThread
        ? { tmid: target.tmid!, u: href, s: sig }
        : { rid: target.rid!, cid: target.cid!, u: href, s: sig },
    )
    wrapped.set(href, `${trackBase}?${params.toString()}`)
  }

  return html.replace(hrefRe, (full, prefix, quote, href) => {
    const w = wrapped.get(href)
    if (!w) return full
    return `${prefix}${quote}${w}${quote}`
  })
}
