// Google Drive API v3 헬퍼
//
// 설계:
//  - accessToken 을 매 호출마다 받아쓴다 (gmail.ts 와 동일 패턴)
//  - 401 응답은 status 필드를 붙여서 throw → 호출자가 forceRefreshGoogleToken 후 재시도
//  - 폴더 구조: 사용자 Drive 최상위의 "MailCaster" 폴더 > "attachments" 서브폴더
//
// Scope 요구:
//  - drive.file  : 앱이 올린/만진 파일에 대한 쓰기/읽기
//  - drive.readonly : 사용자 전체 Drive 목록 조회 (picker 용)

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

const ROOT_FOLDER_NAME = 'MailCaster'
const ATTACH_FOLDER_NAME = 'attachments'

export interface DriveFileMeta {
  id: string
  name: string
  size: number | null
  mimeType: string
  md5Checksum: string | null
  webViewLink: string | null
  iconLink?: string | null
  modifiedTime?: string | null
  thumbnailLink?: string | null
  trashed?: boolean
}

export interface DriveListPage {
  files: DriveFileMeta[]
  nextPageToken: string | null
}

// =============================================================
// 내부 유틸
// =============================================================

async function toError(res: Response): Promise<Error & { status: number }> {
  const bodyText = await res.text().catch(() => '')
  let message = `Drive API ${res.status}`
  try {
    const j = JSON.parse(bodyText)
    message = j?.error?.message || message
  } catch {
    if (bodyText) message = bodyText
  }
  const err = new Error(message) as Error & { status: number }
  err.status = res.status
  return err
}

function authHeaders(accessToken: string, extra: Record<string, string> = {}): HeadersInit {
  return { Authorization: `Bearer ${accessToken}`, ...extra }
}

// Drive API fields 파라미터 — 불필요한 응답 줄이기용
const FILE_FIELDS = 'id,name,size,mimeType,md5Checksum,webViewLink,iconLink,modifiedTime,thumbnailLink,trashed'
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`

function parseMeta(j: Record<string, unknown>): DriveFileMeta {
  return {
    id: String(j.id),
    name: String(j.name ?? ''),
    size: j.size != null ? Number(j.size) : null,
    mimeType: String(j.mimeType ?? 'application/octet-stream'),
    md5Checksum: (j.md5Checksum as string) ?? null,
    webViewLink: (j.webViewLink as string) ?? null,
    iconLink: (j.iconLink as string) ?? null,
    modifiedTime: (j.modifiedTime as string) ?? null,
    thumbnailLink: (j.thumbnailLink as string) ?? null,
    trashed: (j.trashed as boolean) ?? false,
  }
}

// q 파라미터 문자열 이스케이프 (홑따옴표)
function escapeQ(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// =============================================================
// 폴더 관리
// =============================================================

/** 단일 폴더 검색 — 루트 또는 지정 부모 아래에서 이름으로 */
async function findFolder(
  accessToken: string,
  name: string,
  parentId: string | 'root'
): Promise<string | null> {
  const q = [
    `name = '${escapeQ(name)}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
    `'${parentId}' in parents`,
  ].join(' and ')

  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`
  const res = await fetch(url, { headers: authHeaders(accessToken) })
  if (!res.ok) throw await toError(res)
  const j = await res.json()
  const files = (j.files ?? []) as Array<{ id: string }>
  return files[0]?.id ?? null
}

async function createFolder(
  accessToken: string,
  name: string,
  parentId: string | 'root'
): Promise<string> {
  const res = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  if (!res.ok) throw await toError(res)
  const j = await res.json()
  return String(j.id)
}

/**
 * MailCaster/attachments 폴더를 확보하고 ID 반환.
 * 없으면 생성, 있으면 기존 ID 재사용.
 */
export async function ensureMailCasterFolder(accessToken: string): Promise<string> {
  const rootFolderId =
    (await findFolder(accessToken, ROOT_FOLDER_NAME, 'root')) ??
    (await createFolder(accessToken, ROOT_FOLDER_NAME, 'root'))

  const attachFolderId =
    (await findFolder(accessToken, ATTACH_FOLDER_NAME, rootFolderId)) ??
    (await createFolder(accessToken, ATTACH_FOLDER_NAME, rootFolderId))

  return attachFolderId
}

// =============================================================
// 파일 업로드 (multipart/related)
// =============================================================

/**
 * 로컬 File 을 Drive 에 업로드.
 * @param parentFolderId - MailCaster/attachments 폴더 ID (ensureMailCasterFolder 결과)
 */
export async function uploadFile(
  accessToken: string,
  file: File,
  parentFolderId: string
): Promise<DriveFileMeta> {
  const boundary = `-------MC${crypto.randomUUID().replace(/-/g, '')}`
  const metadata = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    parents: [parentFolderId],
  }

  // multipart/related: metadata JSON 파트 + binary 파트
  const header =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${metadata.mimeType}\r\n\r\n`
  const footer = `\r\n--${boundary}--`

  const body = new Blob([header, file, footer])

  const url = `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
    body,
  })
  if (!res.ok) throw await toError(res)
  return parseMeta(await res.json())
}

// =============================================================
// 파일 다운로드 / 메타조회
// =============================================================

/** 파일 바이트를 Blob 으로 다운로드 (메일 첨부 시 사용) */
export async function downloadFile(accessToken: string, fileId: string): Promise<Blob> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
  const res = await fetch(url, { headers: authHeaders(accessToken) })
  if (!res.ok) throw await toError(res)
  return await res.blob()
}

/** 메타데이터만 조회 (발송 전 존재/크기 확인) */
export async function getFileMeta(
  accessToken: string,
  fileId: string
): Promise<DriveFileMeta> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`
  const res = await fetch(url, { headers: authHeaders(accessToken) })
  if (!res.ok) throw await toError(res)
  return parseMeta(await res.json())
}

// =============================================================
// 권한 / 공유 링크 (fallback 용)
// =============================================================

/**
 * "링크 있는 누구나 보기" 권한 설정 + webViewLink 반환.
 * 이미 공개돼있어도 permission 추가는 멱등 (409 아님, 중복 permission 만 추가됨) — 그냥 호출.
 */
export async function shareAsPublicLink(
  accessToken: string,
  fileId: string
): Promise<string> {
  // 1) permission 추가: role=reader, type=anyone
  const permRes = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id`,
    {
      method: 'POST',
      headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }
  )
  if (!permRes.ok) throw await toError(permRes)

  // 2) webViewLink 확보 (업로드 응답에 이미 있지만, picked 파일은 다시 가져와야 할 수 있음)
  const meta = await getFileMeta(accessToken, fileId)
  if (!meta.webViewLink) {
    throw new Error('Drive 링크를 가져올 수 없습니다.')
  }
  return meta.webViewLink
}

// =============================================================
// Drive 파일 목록 (picker 용 — drive.readonly 사용)
// =============================================================

export interface ListDriveFilesOptions {
  /** 검색어 — 파일명 부분 일치 */
  query?: string
  /** 페이지 토큰 (다음 페이지) */
  pageToken?: string
  /** 페이지 크기 (기본 50, 최대 1000) */
  pageSize?: number
  /** mimeType 필터 (예: 'application/pdf', 'image/') — prefix 매칭 */
  mimeTypePrefix?: string
}

export async function listDriveFiles(
  accessToken: string,
  opts: ListDriveFilesOptions = {}
): Promise<DriveListPage> {
  const qParts: string[] = [
    `trashed = false`,
    `mimeType != 'application/vnd.google-apps.folder'`,
  ]
  if (opts.query?.trim()) {
    qParts.push(`name contains '${escapeQ(opts.query.trim())}'`)
  }
  if (opts.mimeTypePrefix) {
    qParts.push(`mimeType contains '${escapeQ(opts.mimeTypePrefix)}'`)
  }
  const q = qParts.join(' and ')

  const params = new URLSearchParams({
    q,
    orderBy: 'modifiedTime desc',
    pageSize: String(opts.pageSize ?? 50),
    fields: LIST_FIELDS,
  })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)

  const url = `${DRIVE_API}/files?${params.toString()}`
  const res = await fetch(url, { headers: authHeaders(accessToken) })
  if (!res.ok) throw await toError(res)
  const j = await res.json()
  return {
    files: (j.files ?? []).map(parseMeta),
    nextPageToken: (j.nextPageToken as string) ?? null,
  }
}
