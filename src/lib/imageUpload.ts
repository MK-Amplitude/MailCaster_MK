// 메일 본문 inline 이미지 업로드.
//   - Supabase Storage 의 public bucket `email-images` 에 저장
//   - 경로: {user_id}/{uuid}.{ext}
//   - 반환: public URL (수신자가 인증 없이 볼 수 있음)
//
// 호환성 — TipTap 의 ResizableImage 는 `<img src="..." width="..." height="...">`
// 형식으로 직렬화. Gmail/Outlook 등 모든 메이저 메일 클라이언트가 width/height
// HTML attribute 는 inline style 보다 잘 존중함.
//
// 수신자 측 표시:
//   - 첫 열람 시 Gmail/Outlook 은 외부 이미지를 차단할 수 있음 (privacy).
//   - 사용자가 "외부 이미지 표시" 한 번 클릭 후엔 영구 표시.
//   - Storage URL 은 영구 — 깨질 일 없음.

import { supabase } from './supabase'

const BUCKET = 'email-images'
const MAX_BYTES = 10 * 1024 * 1024 // 10MB — bucket 정책과 일치

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
])

export interface UploadedImage {
  url: string // public URL — 메일 본문 img src 에 그대로 사용
  path: string // storage path — 추후 삭제용
  width?: number // intrinsic width (선택)
  height?: number // intrinsic height
}

export async function uploadInlineImage(
  file: File,
  userId: string,
): Promise<UploadedImage> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(`지원하지 않는 이미지 형식: ${file.type || '알 수 없음'}`)
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`이미지가 너무 큽니다 (최대 ${MAX_BYTES / 1024 / 1024}MB).`)
  }

  // 파일 이름 충돌 방지 — UUID + 확장자만.
  // (원본 파일명은 보존하지 않음 — privacy + 충돌 회피)
  const ext = extFromMime(file.type) ?? extFromName(file.name) ?? 'bin'
  const id = crypto.randomUUID()
  const path = `${userId}/${id}.${ext}`

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, {
      cacheControl: '31536000', // 1년 캐시 — 한 번 가져가면 재요청 안 함
      contentType: file.type,
      upsert: false,
    })
  if (error) throw new Error(`업로드 실패: ${error.message}`)

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(path)

  // intrinsic 크기 추출 — TipTap 의 width/height 초기값으로 사용 가능.
  let width: number | undefined
  let height: number | undefined
  try {
    const dims = await readImageDimensions(file)
    width = dims.width
    height = dims.height
  } catch {
    // 차원 못 읽어도 OK — TipTap 이 자연 크기로 표시
  }

  return { url: publicUrl, path, width, height }
}

function extFromMime(mime: string): string | null {
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
      return null
  }
}

function extFromName(name: string): string | null {
  const m = name.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : null
}

function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      URL.revokeObjectURL(url)
      resolve({ width: w, height: h })
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}
