// 메일 본문의 <img src="..."> 를 CID inline embed 로 변환.
//
// 목적:
//   1) 비용: 발송 후 Storage 의 이미지를 정리해도 메일은 자기완결적 (이미지 박힘)
//   2) 호환성: 메일 클라이언트의 "외부 이미지 차단" 우회 — 항상 표시됨
//   3) 영속성: Storage URL 이 깨져도 옛 메일의 이미지는 그대로 보임
//
// 동작:
//   본문 HTML 에서 <img> 를 찾아:
//   - data: URL → base64 그대로 추출
//   - https URL → fetch 해서 base64 변환
//   - 각 이미지에 cid:imageN 부여, src 를 그걸로 교체
//
// 외부 URL (e.g. 사용자가 직접 <img src="https://example.com/x.png"> 넣은 경우):
//   fetch 시도 — 성공하면 embed, 실패 (CORS, 404 등) 하면 그대로 둠.
//   외부 이미지 차단 우려가 있지만 사용자 의도 (특정 외부 호스팅) 일 수 있어 보존.
//
// 메일 크기:
//   Gmail 25MB 제한 — 보통 이미지 5장 × 500KB = 2.5MB 정도, 안전.
//   embed 결과가 너무 크면 호출자가 적절히 처리.

export interface InlineImage {
  cid: string // cid:xxx 의 xxx 부분 (브래킷 없는 raw id)
  filename: string
  mimeType: string
  base64: string // unwrapped (76자 wrap 은 buildMime 에서 처리)
}

interface ExtractResult {
  html: string // 변환된 HTML — img src 가 cid:xxx 로 치환됨
  images: InlineImage[] // 메일에 첨부할 inline 이미지들
  totalBytes: number // base64 디코딩 전 raw 크기 합계 — 호출자가 한도 검사
}

// 페치 timeout — 외부 이미지가 hang 하지 않도록.
const FETCH_TIMEOUT_MS = 10_000
// 단일 이미지 최대 크기 — 너무 큰 외부 이미지는 메일 크기 초과 위험.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8MB
// 전체 이미지 합계 — Gmail 25MB 한계 대비 보수적.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 // 20MB

/**
 * HTML 본문의 <img> 를 inline (cid:) 으로 embed 가능한 형식으로 변환.
 * fetch 실패한 이미지는 원본 src 그대로 유지 (메일은 정상 발송).
 */
export async function extractAndInlineImages(html: string): Promise<ExtractResult> {
  // 빠른 패스: img 가 없으면 그대로 반환
  if (!/<img\b[^>]*\bsrc=/i.test(html)) {
    return { html, images: [], totalBytes: 0 }
  }

  // 모든 <img src="..."> 매칭 — 작은따옴표/큰따옴표 모두 지원.
  const imgRe = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi
  const sources = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(html)) !== null) {
    sources.add(m[3])
  }

  // src → InlineImage 매핑 빌드 (병렬 fetch).
  const results = await Promise.allSettled(
    [...sources].map((src) => fetchAndEncodeImage(src)),
  )

  const srcToCid = new Map<string, string>()
  const images: InlineImage[] = []
  let totalBytes = 0

  let index = 1
  for (const [src, r] of [...sources].map((s, i) => [s, results[i]] as const)) {
    if (r.status === 'rejected' || !r.value) continue
    const img = r.value
    if (img.rawBytes > MAX_IMAGE_BYTES) continue
    if (totalBytes + img.rawBytes > MAX_TOTAL_BYTES) continue
    totalBytes += img.rawBytes
    const cid = `mc-img-${index++}-${crypto.randomUUID().slice(0, 8)}`
    srcToCid.set(src, cid)
    images.push({
      cid,
      filename: img.filename,
      mimeType: img.mimeType,
      base64: img.base64,
    })
  }

  // HTML 의 src 들을 cid:xxx 로 치환.
  // 같은 URL 이 여러 img 에 쓰여도 같은 cid 재사용 (메일 크기 최적화).
  const transformedHtml = html.replace(
    imgRe,
    (full, before, _quote, src, after) => {
      const cid = srcToCid.get(src)
      if (!cid) return full // embed 안 한 src 는 그대로
      return `<img${before}src="cid:${cid}"${after}>`
    },
  )

  return { html: transformedHtml, images, totalBytes }
}

async function fetchAndEncodeImage(src: string): Promise<{
  filename: string
  mimeType: string
  base64: string
  rawBytes: number
} | null> {
  // data URL — 이미 base64. 파싱만.
  const dataMatch = src.match(/^data:([^;]+);base64,(.+)$/)
  if (dataMatch) {
    const mimeType = dataMatch[1]
    const base64 = dataMatch[2]
    const rawBytes = Math.ceil((base64.length * 3) / 4)
    return {
      filename: `inline.${extFromMime(mimeType)}`,
      mimeType,
      base64,
      rawBytes,
    }
  }

  // https URL — fetch
  if (!/^https?:\/\//.test(src)) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(src, { signal: controller.signal })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? 'application/octet-stream'
    if (!ct.startsWith('image/')) return null
    const blob = await res.blob()
    if (blob.size === 0) return null
    const arrayBuffer = await blob.arrayBuffer()
    const base64 = arrayBufferToBase64(arrayBuffer)
    const filename = filenameFromUrl(src) ?? `inline.${extFromMime(ct)}`
    return { filename, mimeType: ct, base64, rawBytes: blob.size }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  // 청크 단위로 변환 — 너무 큰 한 번에 변환은 stack overflow 가능
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').pop()
    if (!last) return null
    return decodeURIComponent(last)
  } catch {
    return null
  }
}
