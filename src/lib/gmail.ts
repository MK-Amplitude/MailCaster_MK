// Gmail API 를 사용해 개인 계정으로 메일 전송
// provider_token 은 Supabase Google OAuth 로그인 후 profiles 에 저장됨
//
// 첨부 파일 지원:
//  - attachments 없으면 기존 text/html 단일 파트 유지 (backward compat)
//  - 있으면 multipart/mixed 로 구성 + 각 파트는 base64 인코딩
//  - 비-ASCII 파일명은 RFC 2231 (filename*=UTF-8'') 사용

export interface MailAttachmentRaw {
  filename: string
  mimeType: string
  /** 파일 바이트 — Blob 또는 Uint8Array */
  data: Blob | Uint8Array
}

/**
 * 사전 인코딩된 첨부.
 *
 * 같은 파일을 여러 수신자에게 반복 발송할 때 buildMime 이 호출될 때마다
 * FileReader/btoa 로 base64 재계산하는 비용을 없애기 위해, caller 가 미리
 * encodeAttachmentsForReuse() 로 변환해 루프 내내 재사용한다.
 *
 * N3: N명 × O(파일크기) → 1 × O(파일크기) + N × 문자열복사 로 감소.
 */
export interface MailAttachmentEncoded {
  filename: string
  mimeType: string
  /** unwrapped base64 (76자 줄바꿈 없음 — buildMime 에서 wrapBase64 로 wrap) */
  base64: string
}

export type MailAttachment = MailAttachmentRaw | MailAttachmentEncoded

interface SendMailInput {
  accessToken: string
  from: string
  to: string
  toName?: string | null
  subject: string
  html: string
  replyTo?: string
  attachments?: MailAttachment[]
  /**
   * 본문에 cid: 로 참조되는 inline 이미지들 — multipart/related 의 inline 파트로 들어감.
   * html 의 <img src="cid:xxx"> 와 매칭. 수신자는 외부 fetch 없이 메일 자체에서 표시.
   */
  inlineImages?: Array<{
    cid: string
    filename: string
    mimeType: string
    base64: string // unwrapped
  }>
  /**
   * Cc 헤더에 노출되는 주소들. 빈 배열/undefined 면 헤더 생략.
   * 수신자에게 보이므로 "모두에게 보이는 참조" 를 원할 때 사용.
   */
  cc?: string[]
  /**
   * Bcc 헤더에 노출되는 주소들. 빈 배열/undefined 면 헤더 생략.
   * bulk 발송 모드에서는 수신자 전원을 여기 넣어 단일 요청으로 브로드캐스트한다.
   */
  bcc?: string[]
  /**
   * Gmail thread 안에 답장/팔로업으로 끼우기 — Gmail API 의 threadId 파라미터로 사용.
   * 같이 inReplyTo 도 넘기면 표준 RFC 2822 In-Reply-To / References 헤더가 들어가
   * 모든 메일 클라이언트에서 thread 안 메시지로 인식.
   */
  threadId?: string
  /** 답장 대상 원본 메시지의 Message-ID (꺽쇠 포함/미포함 모두 허용). */
  inReplyTo?: string
  /**
   * 079 — RFC 8058 List-Unsubscribe 헤더 URL (https 만). 지정 시
   * List-Unsubscribe + List-Unsubscribe-Post(One-Click) 헤더 추가. 개별 캠페인 발송 전용.
   */
  listUnsubscribeUrl?: string | null
}

/**
 * CR/LF/NUL + 유니코드 줄분리 문자(LS/PS) 제거 — 헤더 인젝션 방지 (RFC 5322 §2.2).
 * 파일명/제목/수신자명에 "\r\nBcc: evil@..." 같은 페이로드가 주입되면
 * 공격자가 임의 헤더를 추가할 수 있으므로 모든 헤더값 생성 전 반드시 통과시킨다.
 * U+2028 (LINE SEPARATOR) / U+2029 (PARAGRAPH SEPARATOR) 도 일부 파서에서
 * 줄바꿈으로 해석될 수 있어 함께 제거.
 */
function stripCRLF(s: string): string {
   
  return s.replace(/[\r\n\0\u2028\u2029]/g, '')
}

// 단일 encoded-word 1개 (UTF-8 Base64) 로 변환
function encodeOneWord(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)))
  return `=?UTF-8?B?${b64}?=`
}

/**
 * 주소 헤더 (From/Reply-To/Cc/Bcc) 의 display name 부분만 RFC 2047 인코딩.
 *
 * 입력 패턴:
 *   "name@host"           → 그대로 (이름 없음)
 *   "Display <name@host>" → "=?UTF-8?B?...?= <name@host>" (한글 등 비-ASCII 만 인코딩, ASCII 는 그대로)
 *   "name@host" 중 < > 가 없는 raw 주소도 그대로
 *
 * 비-ASCII display name 을 raw UTF-8 로 헤더에 넣으면 받는 메일 클라이언트가
 * "ï̃ëªê·œ" 같은 mojibake 로 표시 (UTF-8 바이트를 Latin-1 로 해석한 결과).
 * 받는 쪽이 어떤 client (Gmail / Outlook / Apple Mail) 에 있든 안전하게 표시되게
 * encoded-word 로 변환.
 */
function encodeAddressHeader(addr: string): string {
  const m = addr.match(/^\s*(.+?)\s*<([^>]+)>\s*$/)
  if (!m) return addr // raw email — name 없음
  const name = m[1].trim()
  const email = m[2].trim()
  if (!name) return `<${email}>`
  // RFC 5322 — 따옴표 있는 경우 벗기고 인코딩 (Gmail UI 가 따옴표 두는 경우 존재).
  const naked = name.replace(/^"(.*)"$/, '$1')
  if (/^[\x20-\x7E]+$/.test(naked)) {
    // ASCII-only 이고 RFC 5322 specials 가 없는 경우 그대로.
    if (!/[()<>[\]:;@\\,."]/.test(naked)) return `${naked} <${email}>`
    // ASCII 인데 specials 포함 — quoted-string 필수.
    // (예: "Doe, John" — 안 감싸면 콤마가 주소 구분자로 해석돼 Gmail 400,
    //  "[VIP] John" 은 Invalid To header, "John (Sales)" 는 괄호가 comment 로 먹혀 이름이 잘림)
    // encodeHeader 는 ASCII 를 그대로 반환하므로 여기서 직접 quoting.
    return `"${naked.replace(/([\\"])/g, '\\$1')}" <${email}>`
  }
  // 비-ASCII — encoded-word 로.
  return `${encodeHeader(naked)} <${email}>`
}

function encodeHeader(value: string): string {
  // RFC 2047 — 비-ASCII 헤더는 UTF-8 Base64 인코딩.
  // 단일 encoded-word 는 75자 제한이 있으므로 원본을 UTF-8 바이트 기준 chunk 로 잘라
  // 여러 encoded-word 로 인코딩 후 공백으로 연결한다 (multi-byte 경계 안전).
  // CR/LF 인젝션 방지: 모든 입력을 먼저 strip.
  const clean = stripCRLF(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean

  const encoder = new TextEncoder()
  const MAX_BYTES_PER_WORD = 42 // prefix/suffix 12자 + base64(42 bytes ≈ 56자) = 68자 < 75자
  const parts: string[] = []
  let buf = ''
  let bufBytes = 0
  for (const ch of clean) {
    const chBytes = encoder.encode(ch).length
    if (bufBytes + chBytes > MAX_BYTES_PER_WORD && buf) {
      parts.push(encodeOneWord(buf))
      buf = ''
      bufBytes = 0
    }
    buf += ch
    bufBytes += chBytes
  }
  if (buf) parts.push(encodeOneWord(buf))
  return parts.join(' ')
}

// base64 를 RFC 2045 규정대로 76자마다 CRLF 줄바꿈
function wrapBase64(s: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width))
  return chunks.join('\r\n')
}

// URL-safe base64 (Gmail API 요구)
function b64url(input: string): string {
  return btoa(unescape(encodeURIComponent(input)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Uint8Array → base64 (32KB chunk 로 나눠 call stack 보호)
function u8ToBase64(u8: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    binary += String.fromCharCode.apply(null, slice as any)
  }
  return btoa(binary)
}

/**
 * Blob → base64 문자열 (FileReader.readAsDataURL 사용).
 * S8: Uint8Array 로 복사 후 String.fromCharCode 하는 경로보다 메모리 효율이 좋다.
 * 18MB 기준 U8Array(18MB) + binary string(18MB) 중간 복사본을 피함.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // "data:<mime>;base64,<data>" 에서 base64 부분만 추출
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 실패'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 첨부 바이트를 unwrapped base64 로 변환.
 *   - base64 필드 보유: 이미 인코딩됨 → 그대로 반환 (수신자마다 재인코딩 방지)
 *   - Blob: FileReader.readAsDataURL 경로
 *   - Uint8Array: btoa 경로
 */
async function attachmentToBase64(att: MailAttachment): Promise<string> {
  if ('base64' in att) return att.base64
  if (att.data instanceof Blob) return await blobToBase64(att.data)
  return u8ToBase64(att.data)
}

/**
 * 여러 수신자에게 동일 첨부를 반복 발송할 때 사용하는 사전 인코딩 유틸.
 * N명 발송 기준 FileReader 호출 횟수를 N→1 로 축소.
 *
 * 주의: base64 는 원본 바이트의 약 1.333배 메모리를 차지한다. 이 함수 호출 이후
 * caller 는 원본 Blob/Uint8Array 참조를 놓아주는 게 좋다 (중복 보관 방지).
 */
export async function encodeAttachmentsForReuse(
  attachments: MailAttachmentRaw[]
): Promise<MailAttachmentEncoded[]> {
  const encoded: MailAttachmentEncoded[] = []
  for (const att of attachments) {
    const base64 =
      att.data instanceof Blob ? await blobToBase64(att.data) : u8ToBase64(att.data)
    encoded.push({
      filename: att.filename,
      mimeType: att.mimeType,
      base64,
    })
  }
  return encoded
}

// RFC 5987 / 2231 — 비-ASCII filename 파라미터
function encodeRFC2231(value: string): string {
  return `UTF-8''${encodeURIComponent(value).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/**
 * filename 파라미터 구성 — 한글 등 비-ASCII 파일명을 모든 메일 클라이언트에서
 * 깨지지 않게 표시하는 hybrid 전략.
 *
 * 표준 (RFC 5987 / 2231) 만 사용하면 filename*=UTF-8''... 만 보내면 되지만,
 * Gmail UI 가 가끔 filename= 의 ASCII fallback 만 노출 — 한글이 underscore 로
 * 표시되는 문제 발생 (실측됨).
 *
 * 호환성을 위해 filename= 에 RFC 2047 encoded-word 도 함께 사용. quoted-string
 * 내부의 encoded-word 는 RFC 5322 §3.2.5 에 따르면 비표준이지만 Gmail/Outlook/
 * Apple Mail 등 모든 메이저 클라이언트가 디코딩한다 (de-facto 표준).
 *
 * 동시에 filename*= 도 같이 보내서 RFC 표준 따르는 신형 클라이언트는 그쪽 우선.
 */
function dispositionFilename(filename: string): string {
  const clean = stripCRLF(filename)
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) {
    return `filename="${clean}"`
  }
  // 비-ASCII: encoded-word + RFC 5987 둘 다.
  return `filename="${encodeOneWord(clean)}"; filename*=${encodeRFC2231(clean)}`
}

/**
 * Content-Type 의 name 파라미터 — filename 과 동일 전략.
 * (Content-Type name= 은 deprecated 이지만 일부 구형 클라이언트가 참조하므로 동시 제공.)
 */
function contentTypeName(filename: string): string {
  const clean = stripCRLF(filename)
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `name="${clean}"`
  return `name="${encodeOneWord(clean)}"; name*=${encodeRFC2231(clean)}`
}

/**
 * 주소 목록을 헤더 한 줄용 comma-separated 문자열로 변환.
 * 각 주소는 stripCRLF 로 인젝션 방지 후 display name 부분 RFC 2047 인코딩.
 */
function joinAddressList(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined
  const cleaned = list
    .map((a) => encodeAddressHeader(stripCRLF(a).trim()))
    .filter(Boolean)
  return cleaned.length > 0 ? foldAddressList(cleaned) : undefined
}

/**
 * 주소 목록 헤더 folding (RFC 5322 §2.1.1 — 한 줄 998자 한도, 권장 78자).
 * 콤마 뒤에서 CRLF + SP 로 줄을 접는다 (send-scheduled-campaigns 의 foldAddressList 와 동일 규칙).
 * 각 주소는 이미 stripCRLF 를 거쳤으므로 결과의 CRLF 는 여기서 넣은 folding 뿐이다.
 * bulk 발송의 To(최대 500명 ≈ 15k자)가 한 줄로 나가 Gmail/수신 MTA 가 거부·절단하던 문제 방지.
 */
function foldAddressList(items: string[]): string {
  let out = ''
  let lineLen = 4 // "To: " / "Cc: " 접두
  items.forEach((item, idx) => {
    if (idx === 0) {
      out = item
      lineLen += item.length
    } else if (lineLen + 2 + item.length > 76) {
      out += `,\r\n ${item}`
      lineLen = 1 + item.length
    } else {
      out += `, ${item}`
      lineLen += 2 + item.length
    }
  })
  return out
}

// "Display Name <a@b>" 또는 raw 주소에서 이메일 부분만 추출.
function extractEmailPart(addr: string): string {
  const m = addr.match(/<([^>]+)>/)
  return (m ? m[1] : addr).trim()
}

// 단일 이메일 주소 유효성 — @ 위치, 공백/CRLF/콤마 없는지 검사.
// 주의: bulk 발송의 To 는 콤마로 연결된 목록이므로 호출자가 콤마 분리 후 개별 검증.
function assertValidEmail(addr: string, field: string): void {
  const email = extractEmailPart(addr)
  const atIdx = email.lastIndexOf('@')
  if (atIdx < 1 || atIdx === email.length - 1 || /[\r\n\s,]/.test(email)) {
    throw new Error(`Invalid ${field} address: ${email.slice(0, 80)}`)
  }
}

async function buildMime(input: Omit<SendMailInput, 'accessToken'>): Promise<string> {
  const { from, to, toName, subject, html, replyTo, attachments, cc, bcc, inReplyTo, listUnsubscribeUrl } = input
  // 최종 html 이 참조하지 않는 cid 이미지는 제외 — 개인화 override 본문 등에서
  // 미참조 inline 파트가 수신 클라이언트에 정체불명 첨부(inline.png)로 보이는 문제 방지.
  const inlineImages = input.inlineImages?.filter((img) => html.includes(`cid:${img.cid}`))
  // 모든 헤더 입력값은 CR/LF 인젝션 방지를 위해 선제 sanitize.
  const cleanFrom = encodeAddressHeader(stripCRLF(from))
  const cleanTo = stripCRLF(to)
  // 이메일 주소 형식 검증 — 잘못된 주소가 Gmail API 에 전달되기 전에 차단.
  // To 는 bulk 발송에서 "a@x.com, b@y.com" 콤마 목록이 올 수 있으므로 분리 후 개별 검증.
  const toParts = cleanTo.split(',').map((p) => p.trim())
  for (const part of toParts) assertValidEmail(part, 'To')
  if (cc) for (const c of cc) assertValidEmail(stripCRLF(c), 'Cc')
  if (bcc) for (const b of bcc) assertValidEmail(stripCRLF(b), 'Bcc')
  const cleanReplyTo = replyTo ? encodeAddressHeader(stripCRLF(replyTo)) : undefined
  const ccLine = joinAddressList(cc)
  const bccLine = joinAddressList(bcc)
  // To 표시 이름도 encodeAddressHeader 경유 — ASCII 특수문자(콤마 등) quoted-string 처리.
  // (encodeHeader 직접 호출은 ASCII 를 그대로 통과시켜 "Doe, John" 이 주소 2개로 갈라졌음)
  // 콤마 목록(bulk)은 주소 단위로 folding — 998자 줄 한도 초과 방지.
  const toHeader =
    toParts.length > 1
      ? foldAddressList(toParts.map((p) => encodeAddressHeader(p)))
      : toName
        ? encodeAddressHeader(`${stripCRLF(toName).replace(/[<>]/g, '')} <${cleanTo.trim()}>`)
        : cleanTo.trim()
  const bodyBase64 = wrapBase64(btoa(unescape(encodeURIComponent(html))))

  const baseHeaders: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (ccLine) baseHeaders.push(`Cc: ${ccLine}`)
  // Bcc 헤더를 MIME 에 포함해도 Gmail API 가 수신자로 인식하고 전송 시 스트립해준다.
  // (RFC 상 Bcc 는 수신자에게 노출되면 안 되지만, gmail.googleapis.com 은 내부적으로 제거)
  if (bccLine) baseHeaders.push(`Bcc: ${bccLine}`)
  if (cleanReplyTo) baseHeaders.push(`Reply-To: ${cleanReplyTo}`)
  // 답장 / 팔로업 — In-Reply-To + References 헤더 표준. 모든 클라이언트가 thread
  // 안 메시지로 인식. Message-ID 는 <id@host> 형식이어야 표준 — 없으면 자동으로 감싼다.
  if (inReplyTo) {
    const wrapped = inReplyTo.trim().startsWith('<') ? inReplyTo.trim() : `<${inReplyTo.trim()}>`
    baseHeaders.push(`In-Reply-To: ${wrapped}`)
    baseHeaders.push(`References: ${wrapped}`)
  }
  // RFC 8058 — Gmail/Yahoo 대량 발신자 요건. https URL 만 (꺾쇠/공백/CRLF 제거 후)
  const cleanUnsub = listUnsubscribeUrl ? stripCRLF(listUnsubscribeUrl).replace(/[<>\s]/g, '') : ''
  if (/^https:\/\//i.test(cleanUnsub)) {
    baseHeaders.push(`List-Unsubscribe: <${cleanUnsub}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  baseHeaders.push(`Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0')

  const hasInline = inlineImages && inlineImages.length > 0
  const hasAttachments = attachments && attachments.length > 0

  // 첨부 / inline 둘 다 없으면 단일 text/html
  if (!hasInline && !hasAttachments) {
    const headers = [
      ...baseHeaders,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ]
    return headers.join('\r\n') + '\r\n\r\n' + bodyBase64
  }

  // multipart/related 또는 multipart/mixed 빌더 — boundary 충돌 0
  const newBoundary = () => `MC_${crypto.randomUUID().replace(/-/g, '')}`

  // 본문 + inline 이미지 묶음 (multipart/related). inline 없으면 단순 text/html 파트.
  const buildBodyPart = (): string => {
    if (!hasInline) {
      return [
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        bodyBase64,
      ].join('\r\n')
    }
    const innerBoundary = newBoundary()
    const lines: string[] = [
      `Content-Type: multipart/related; boundary="${innerBoundary}"`,
      '',
      `--${innerBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
    ]
    for (const img of inlineImages!) {
      lines.push(
        `--${innerBoundary}`,
        `Content-Type: ${img.mimeType}; ${contentTypeName(img.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: inline; ${dispositionFilename(img.filename)}`,
        `Content-ID: <${img.cid}>`,
        '',
        wrapBase64(img.base64),
      )
    }
    lines.push(`--${innerBoundary}--`)
    return lines.join('\r\n')
  }

  // 일반 첨부 없으면 multipart/related 가 곧 top-level.
  if (!hasAttachments) {
    const topBoundary = newBoundary()
    const headers = [
      ...baseHeaders,
      `Content-Type: multipart/related; boundary="${topBoundary}"`,
    ]
    const lines: string[] = [
      `--${topBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
    ]
    for (const img of inlineImages!) {
      lines.push(
        `--${topBoundary}`,
        `Content-Type: ${img.mimeType}; ${contentTypeName(img.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: inline; ${dispositionFilename(img.filename)}`,
        `Content-ID: <${img.cid}>`,
        '',
        wrapBase64(img.base64),
      )
    }
    lines.push(`--${topBoundary}--`, '')
    return headers.join('\r\n') + '\r\n\r\n' + lines.join('\r\n')
  }

  // 일반 첨부도 있으면 multipart/mixed 로 감싸고, 첫 파트는 (multipart/related | text/html), 나머지는 attachment.
  const topBoundary = newBoundary()
  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${topBoundary}"`,
  ]
  const parts: string[] = [`--${topBoundary}`, buildBodyPart()]
  for (const att of attachments!) {
    const attB64 = wrapBase64(await attachmentToBase64(att))
    parts.push(
      `--${topBoundary}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; ${contentTypeName(att.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(att.filename)}`,
      '',
      attB64,
    )
  }
  parts.push(`--${topBoundary}--`, '')
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
}

export interface GmailSendResult {
  id: string
  threadId: string
}

/**
 * sendGmail 이 던지는 에러. status 외에 Google 에러 reason 을 보존해 호출자가
 * 일일 한도 / 속도 제한 / 권한 오류를 구분할 수 있게 한다.
 */
export type GmailSendError = Error & {
  status?: number
  /** error.errors[0].reason (dailyLimitExceeded / rateLimitExceeded / insufficientPermissions ...) */
  reason?: string
  /** error.status (RESOURCE_EXHAUSTED / PERMISSION_DENIED ...) */
  googleStatus?: string
  /** Retry-After 헤더 또는 "Retry after <ISO>" 메시지에서 계산한 대기 시간 */
  retryAfterMs?: number
  /**
   * 클라이언트 측 타임아웃 abort / 네트워크 단절 — 요청이 Gmail 에 도달해 이미 발송됐을 수
   * 있으므로 절대 자동 재시도하면 안 된다 (중복 발송).
   */
  timedOut?: boolean
  networkError?: boolean
}

/**
 * - auth: 401 (토큰 만료/폐기 — 호출자가 1회 강제 refresh 후에도 401 이면 재로그인 필요)
 * - account: 계정 단위 영구 거부 (403 insufficientPermissions/domainPolicy/forbidden,
 *   400 failedPrecondition 'Mail service not enabled' 등) — 다음 수신자도 똑같이 실패하므로
 *   발송 루프 전체를 멈춰야 한다 (수신자별 failed 박제 금지).
 * - timeout/network: 결과 불명 — 재시도 금지 (중복 발송).
 */
/**
 * 결과 불명 발송(타임아웃/연결 끊김 — 요청이 Gmail 에 도달했을 수 있음)의 수신자 error_message.
 * send-scheduled-campaigns 와 동일 문구. 이런 수신자는 재시도·pending 복귀 금지 (중복 발송).
 */
export const AMBIGUOUS_SEND_MESSAGE =
  '전송 결과 불확실 — Gmail 보낸편지함 확인 후 필요 시 개별 재발송'

/** 요청이 Gmail 에 도달했는지 알 수 없는 오류 (타임아웃 abort / 네트워크 단절). */
export function isAmbiguousSendError(e: unknown): boolean {
  const err = e as GmailSendError
  return !!(err?.timedOut || err?.networkError)
}

export type GmailErrorKind =
  | 'daily_quota'
  | 'rate_limit'
  | 'auth'
  | 'account'
  | 'timeout'
  | 'network'
  | 'other'

const QUOTA_REASONS = new Set(['dailyLimitExceeded', 'quotaExceeded', 'dailyLimitExceededUnreg'])
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])
const ACCOUNT_403_REASONS = new Set(['insufficientPermissions', 'domainPolicy', 'forbidden'])
// "Retry after" 가 이보다 길면 일시적 속도 제한이 아니라 발송 한도 소진으로 본다.
const QUOTA_RETRY_AFTER_MS = 10 * 60_000

function isAccountWideFailure(err: GmailSendError): boolean {
  const status = err.status
  const reason = err.reason ?? ''
  const msg = (err.message ?? '').toLowerCase()
  if (status === 400) {
    return (
      reason === 'failedPrecondition' ||
      err.googleStatus === 'FAILED_PRECONDITION' ||
      msg.includes('mail service not enabled') ||
      msg.includes('precondition check failed')
    )
  }
  if (status === 403) {
    return (
      ACCOUNT_403_REASONS.has(reason) ||
      err.googleStatus === 'PERMISSION_DENIED' ||
      msg.includes('insufficient permission') ||
      msg.includes('domain policy') ||
      msg.includes('delegation denied')
    )
  }
  return false
}

/** Gmail 발송 에러 분류 — 발송 루프의 재시도/중단 판단용. */
export function classifyGmailError(e: unknown): GmailErrorKind {
  const err = e as GmailSendError
  if (err?.timedOut) return 'timeout'
  if (err?.networkError) return 'network'
  const status = err?.status
  if (status === 401) return 'auth'
  if (status === 400) return isAccountWideFailure(err) ? 'account' : 'other'
  if (status !== 429 && status !== 403) return 'other'
  const reason = err.reason ?? ''
  const msg = (err.message ?? '').toLowerCase()
  if (
    QUOTA_REASONS.has(reason) ||
    msg.includes('daily') ||
    msg.includes('sending limit') ||
    (err.retryAfterMs ?? 0) > QUOTA_RETRY_AFTER_MS
  ) {
    return 'daily_quota'
  }
  if (status === 429 || RATE_REASONS.has(reason) || err.googleStatus === 'RESOURCE_EXHAUSTED') {
    return 'rate_limit'
  }
  if (isAccountWideFailure(err)) return 'account'
  return 'other'
}

function parseRetryAfter(headerValue: string | null, message: string): number | undefined {
  if (headerValue) {
    const secs = Number(headerValue)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(headerValue)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  // Gmail 발송 한도: "User-rate limit exceeded.  Retry after 2026-10-06T01:23:45.678Z"
  const m = message.match(/retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i)
  if (m) {
    const at = Date.parse(m[1])
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  return undefined
}

// JSON {raw} 메타데이터 엔드포인트는 소형 메시지 전용 — 요청 본문이 수 MB 를 넘으면 413.
// 그 이상은 /upload 엔드포인트(최대 35MB, base64 이중 인코딩 없음)로 보낸다.
const JSON_ENDPOINT_MAX_RAW_CHARS = 4.5 * 1024 * 1024
const SEND_JSON_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const SEND_UPLOAD_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'

// 업로드 크기에 비례한 타임아웃 — 큰 첨부를 느린 업링크로 올릴 때 업로드 도중 abort 되지 않게.
function sendTimeoutMs(bodyBytes: number): number {
  return Math.min(180_000, 30_000 + Math.ceil((bodyBytes / (1024 * 1024)) * 15_000))
}

export async function sendGmail(input: SendMailInput): Promise<GmailSendResult> {
  // threadId 는 Gmail 내부 hex 문자열 — 다른 형식은 API 오류를 일으키거나
  // 로그에 사용자 입력이 그대로 남을 수 있어 화이트리스트 검증.
  if (input.threadId && !/^[0-9a-f]+$/i.test(input.threadId)) {
    throw new Error(`Invalid threadId format: ${input.threadId.slice(0, 40)}`)
  }
  const mime = await buildMime(input)
  const mimeBlob = new Blob([mime], { type: 'message/rfc822' })
  // base64url 결과 길이 ≈ 바이트 × 4/3
  const estRawChars = Math.ceil(mimeBlob.size / 3) * 4

  let url: string
  let contentType: string
  let body: BodyInit
  let bodyBytes: number
  if (estRawChars < JSON_ENDPOINT_MAX_RAW_CHARS) {
    const raw = b64url(mime)
    url = SEND_JSON_URL
    contentType = 'application/json'
    body = JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw })
    bodyBytes = raw.length
  } else if (!input.threadId) {
    url = `${SEND_UPLOAD_URL}?uploadType=media`
    contentType = 'message/rfc822'
    body = mimeBlob
    bodyBytes = mimeBlob.size
  } else {
    // threadId 메타데이터가 필요하면 multipart 업로드 (JSON 메타 파트 + message/rfc822 파트).
    const boundary = `MCU_${crypto.randomUUID().replace(/-/g, '')}`
    const multipart = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ threadId: input.threadId }),
      `\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
      mimeBlob,
      `\r\n--${boundary}--`,
    ])
    url = `${SEND_UPLOAD_URL}?uploadType=multipart`
    contentType = `multipart/related; boundary=${boundary}`
    body = multipart
    bodyBytes = multipart.size
  }

  // fetch 의 default 타임아웃은 무한대 — Gmail 이 hang 하면 발송 버튼이 영원히 대기.
  // 타임아웃은 "결과 불명" 이므로 호출자는 재시도하지 말아야 한다 (timedOut 플래그).
  const timeoutMs = sendTimeoutMs(bodyBytes)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': contentType,
      },
      body,
      signal: controller.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      const err = new Error(
        `Gmail API 호출 타임아웃 (${Math.round(timeoutMs / 1000)}초 초과) — 발송 여부 불확실`,
      ) as GmailSendError
      err.status = 504
      err.timedOut = true
      throw err
    }
    // fetch 거부 = 응답을 받지 못함 (오프라인 / 연결 끊김 / 리셋 등) — 업로드 후 끊겼으면
    // 이미 발송됐을 수도 있으므로 전부 결과 불명(networkError)으로 표시한다. 재시도 금지.
    const err = new Error(
      `Gmail API 네트워크 오류: ${e instanceof Error ? e.message : String(e)}`,
    ) as GmailSendError
    err.networkError = true
    throw err
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text()
    let message = `Gmail API ${res.status}`
    let reason: string | undefined
    let googleStatus: string | undefined
    try {
      const j = JSON.parse(text)
      message = j?.error?.message || message
      reason =
        j?.error?.errors?.[0]?.reason ??
        (Array.isArray(j?.error?.details)
          ? j.error.details.find((d: { reason?: string }) => d?.reason)?.reason
          : undefined)
      googleStatus = j?.error?.status
    } catch {
      if (text) message = text
    }
    const err = new Error(message) as GmailSendError
    err.status = res.status
    err.reason = reason
    err.googleStatus = googleStatus
    err.retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), message)
    throw err
  }

  // 2xx = Gmail 이 이미 발송함. 응답 본문을 못 읽으면 id 를 모를 뿐 발송은 된 것이므로
  // 결과 불명으로 표시해 호출자가 재시도/pending 복귀하지 않게 한다.
  let json: GmailSendResult
  try {
    json = (await res.json()) as GmailSendResult
  } catch (e) {
    const err = new Error(
      `Gmail API 응답 읽기 실패 (발송됐을 수 있음): ${e instanceof Error ? e.message : String(e)}`,
    ) as GmailSendError
    err.networkError = true
    throw err
  }
  if (!json?.id) {
    const err = new Error('Gmail API 응답에 message id 가 없습니다 (발송됐을 수 있음)') as GmailSendError
    err.networkError = true
    throw err
  }
  return json
}

/**
 * Gmail 메시지의 RFC 2822 Message-ID 헤더 값을 조회.
 * In-Reply-To 헤더로 넘길 표준 식별자 — Gmail 내부 message id (`19abc...`) 와 다름.
 * 조회 실패 시 null. 호출자는 그 경우 threadId 만으로 thread 안 메시지 처리.
 */
export async function fetchMessageRfcId(
  accessToken: string,
  gmailMessageId: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
        gmailMessageId,
      )}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const headers = data.payload?.headers ?? []
    const found = headers.find(
      (h: { name: string }) => h.name.toLowerCase() === 'message-id',
    )
    return found?.value ?? null
  } catch {
    return null
  }
}

/**
 * Gmail 메시지에서 답장 작성용 메타데이터 (subject / message-id / from / to / date) 조회.
 * ThreadComposeDialog 가 reply/forward 시 원본을 인용하기 위해 사용.
 */
export interface ThreadOriginalMeta {
  rfcMessageId: string | null
  subject: string | null
  from: string | null
  to: string | null
  date: string | null
}

export async function fetchOriginalMeta(
  accessToken: string,
  gmailMessageId: string,
): Promise<ThreadOriginalMeta> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
        gmailMessageId,
      )}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      return { rfcMessageId: null, subject: null, from: null, to: null, date: null }
    }
    const data = await res.json()
    const headers = data.payload?.headers ?? []
    const pick = (name: string): string | null => {
      const h = headers.find(
        (x: { name: string }) => x.name.toLowerCase() === name.toLowerCase(),
      )
      return h?.value ?? null
    }
    return {
      rfcMessageId: pick('Message-ID'),
      subject: pick('Subject'),
      from: pick('From'),
      to: pick('To'),
      date: pick('Date'),
    }
  } catch {
    return { rfcMessageId: null, subject: null, from: null, to: null, date: null }
  }
}
