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
   * Cc 헤더에 노출되는 주소들. 빈 배열/undefined 면 헤더 생략.
   * 수신자에게 보이므로 "모두에게 보이는 참조" 를 원할 때 사용.
   */
  cc?: string[]
  /**
   * Bcc 헤더에 노출되는 주소들. 빈 배열/undefined 면 헤더 생략.
   * bulk 발송 모드에서는 수신자 전원을 여기 넣어 단일 요청으로 브로드캐스트한다.
   */
  bcc?: string[]
}

/**
 * CR/LF/NUL + 유니코드 줄분리 문자(LS/PS) 제거 — 헤더 인젝션 방지 (RFC 5322 §2.2).
 * 파일명/제목/수신자명에 "\r\nBcc: evil@..." 같은 페이로드가 주입되면
 * 공격자가 임의 헤더를 추가할 수 있으므로 모든 헤더값 생성 전 반드시 통과시킨다.
 * U+2028 (LINE SEPARATOR) / U+2029 (PARAGRAPH SEPARATOR) 도 일부 파서에서
 * 줄바꿈으로 해석될 수 있어 함께 제거.
 */
function stripCRLF(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\r\n\0\u2028\u2029]/g, '')
}

// 단일 encoded-word 1개 (UTF-8 Base64) 로 변환
function encodeOneWord(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)))
  return `=?UTF-8?B?${b64}?=`
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
 * 비-ASCII 문자를 underscore 로 치환한 ASCII-safe fallback.
 * RFC 5322 quoted-string 에 들어갈 수 있도록 따옴표/백슬래시/제어문자도 제거한다.
 * `filename*=UTF-8''...` (RFC 5987) 미지원 클라이언트용 fallback 문자열.
 */
function asciiFallbackName(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
}

/**
 * filename 파라미터 구성.
 * ASCII-only: quoted-string 그대로.
 * 비-ASCII: ASCII fallback(filename=) + RFC 5987 (filename*=) 동시 제공.
 *   → RFC 2047 encoded-word 는 quoted-string 내부에서 금지(§5)이므로 사용하지 않는다.
 */
function dispositionFilename(filename: string): string {
  const clean = stripCRLF(filename)
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) {
    return `filename="${clean}"`
  }
  return `filename="${asciiFallbackName(clean)}"; filename*=${encodeRFC2231(clean)}`
}

/**
 * Content-Type 의 name 파라미터 구성. 정책은 filename= 과 동일.
 * RFC 2231 은 name*= 도 지원하므로 비-ASCII 도 UTF-8 로 정확히 전달된다.
 */
function contentTypeName(filename: string): string {
  const clean = stripCRLF(filename)
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `name="${clean}"`
  return `name="${asciiFallbackName(clean)}"; name*=${encodeRFC2231(clean)}`
}

/**
 * 주소 목록을 헤더 한 줄용 comma-separated 문자열로 변환.
 * 각 주소는 stripCRLF 로 인젝션 방지 후 trim; 빈 값은 제거.
 */
function joinAddressList(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined
  const cleaned = list.map((a) => stripCRLF(a).trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned.join(', ') : undefined
}

async function buildMime(input: Omit<SendMailInput, 'accessToken'>): Promise<string> {
  const { from, to, toName, subject, html, replyTo, attachments, cc, bcc } = input
  // 모든 헤더 입력값은 CR/LF 인젝션 방지를 위해 선제 new sanitize.
  const cleanFrom = stripCRLF(from)
  const cleanTo = stripCRLF(to)
  const cleanReplyTo = replyTo ? stripCRLF(replyTo) : undefined
  const ccLine = joinAddressList(cc)
  const bccLine = joinAddressList(bcc)
  const toHeader = toName ? `${encodeHeader(toName)} <${cleanTo}>` : cleanTo
  const bodyBase64 = wrapBase64(btoa(unescape(encodeURIComponent(html))))

  const baseHeaders: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (ccLine) baseHeaders.push(`Cc: ${ccLine}`)
  // Bcc 헤더를 MIME 에 포함해도 Gmail API 가 수신자로 인식하고 전송 시 스트립해준다.
  // (RFC 상 Bcc 는 수신자에게 노출되면 안 되지만, gmail.googleapis.com 은 내부적으로 제거)
  if (bccLine) baseHeaders.push(`Bcc: ${bccLine}`)
  if (cleanReplyTo) baseHeaders.push(`Reply-To: ${cleanReplyTo}`)
  baseHeaders.push(`Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0')

  // 첨부 없으면 기존 구조 유지
  if (!attachments || attachments.length === 0) {
    const headers = [
      ...baseHeaders,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ]
    return headers.join('\r\n') + '\r\n\r\n' + bodyBase64
  }

  // multipart/mixed — crypto.randomUUID() 로 충돌 가능성 사실상 0
  // ("-" 제거로 MIME boundary 허용 문자만 사용)
  const boundary = `MC_${crypto.randomUUID().replace(/-/g, '')}`
  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]

  const parts: string[] = []

  // body part
  parts.push(
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyBase64
  )

  // attachment parts — Blob 은 FileReader, Uint8Array 는 기존 경로
  for (const att of attachments) {
    const attB64 = wrapBase64(await attachmentToBase64(att))
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; ${contentTypeName(att.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(att.filename)}`,
      '',
      attB64
    )
  }

  parts.push(`--${boundary}--`, '')

  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
}

export interface GmailSendResult {
  id: string
  threadId: string
}

export async function sendGmail(input: SendMailInput): Promise<GmailSendResult> {
  const mime = await buildMime(input)
  const raw = b64url(mime)

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!res.ok) {
    const body = await res.text()
    let message = `Gmail API ${res.status}`
    try {
      const j = JSON.parse(body)
      message = j?.error?.message || message
    } catch {
      if (body) message = body
    }
    const err = new Error(message) as Error & { status?: number }
    err.status = res.status
    throw err
  }

  const json = (await res.json()) as GmailSendResult
  return json
}
