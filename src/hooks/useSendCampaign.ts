import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import {
  sendGmail,
  encodeAttachmentsForReuse,
  fetchMessageRfcId,
  classifyGmailError,
  AMBIGUOUS_SEND_MESSAGE,
  type MailAttachment,
  type GmailErrorKind,
  type GmailSendError,
} from '@/lib/gmail'
import { extractAndInlineImages } from '@/lib/inlineImages'
import { getFreshGoogleToken, forceRefreshGoogleToken } from '@/lib/googleToken'
import { downloadFile, getFileMeta, shareAsPublicLink } from '@/lib/drive'
import { extractVariables, renderTemplate, renderTemplateHtml, bodyAlreadyContainsSignature } from '@/lib/mailMerge'
import { escapeHtml, formatBytes } from '@/lib/utils'
import { chunk } from '@/lib/fetchAll'
import { toast } from 'sonner'
import type { Recipient } from '@/types/campaign'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']

interface SendArgs {
  campaignId: string
}

// 첨부 vs Drive 링크 모드 경계 — 첨부 원본 + inline 이미지 바이트 합계 기준.
// 15MB 원본 → base64(+CRLF) ≈ 20.6MB + 본문/헤더 → Gmail 25MB 메시지 한도 안쪽 (서버 경로와 동일 값).
const CLIENT_ATTACHMENT_SAFE_THRESHOLD = 15 * 1024 * 1024
// C-1: 'sending' 캠페인을 "고착" 으로 보는 lease 나이 — UI/useResetStuckCampaign 의
// SEND_LEASE_STALE_MS 와 동일 10분. (서버 cron 은 2분 간격, 자발적 일시정지 시 lease 를 now-85s 로
//  내려놓고, 활성 캠페인이 여럿이면 라운드로빈으로 tick 을 기다리므로 짧은 기준은 정상 서버 발송을
//  고착으로 오판한다. 낡은 lease 는 서버가 스스로 재개한다.)
const STUCK_LEASE_MS = 600_000
// lease heartbeat 주기 — 발송 루프 전체(Gmail 업로드·재시도 대기·수신자 간 지연 포함) 동안
// 최소 이 주기로 CAS 갱신해 서버 due 쿼리의 90초 stale 판정에 걸리지 않게 한다.
const LEASE_HEARTBEAT_MS = 30_000
// 수신거부/차단 수신자 failed 마킹 시 .in('id', …) 청크 크기 (서버 updateRecipientsByIds 와 동일)
const SUPPRESS_UPDATE_CHUNK = 100
const BROWSER_STOPPED_REASON =
  '브라우저 발송이 중단되었습니다 — 남은 수신자는 이 화면에서 다시 보낼 수 있습니다.'
const SUPPRESSION_PAGE_SIZE = 1000
// 결과 불명(타임아웃/네트워크) 발송이 연속 이만큼 나오면 연결 단절로 보고 루프 중단 (C-5 보조).
const MAX_CONSECUTIVE_AMBIGUOUS = 3
// 이 주기마다 profiles.token_expires_at 기준으로 토큰을 선제 갱신 (만료 5분 전).
const TOKEN_CHECK_INTERVAL_MS = 4 * 60_000
const TOKEN_MIN_VALIDITY_MS = 5 * 60_000
const RECIPIENT_PAGE_SIZE = 1000

/**
 * 발송 루프를 중단시키는 사유 — 남은 수신자는 pending 으로 남아 '브라우저에서 재발송' 으로 이어간다.
 *   - account: 계정 단위 영구 거부 (권한 부족/도메인 정책/Gmail 미사용 계정) — C-6
 *   - network: 결과 불명 오류가 연속 발생 (오프라인 등) — 해당 수신자들은 failed(불확실) 처리됨
 *   - record: Gmail 발송 후 DB 기록 실패 — 그 행은 'sending' 으로 남겨 재발송 대상에서 제외
 */
type StopReason = 'daily_quota' | 'rate_limit' | 'auth' | 'account' | 'network' | 'record'

/** 다른 실행(서버 cron / 다른 탭)이 lease 를 가져감 — 캠페인/수신자 상태를 건드리지 않고 즉시 중단. */
class LeaseLostError extends Error {
  constructor() {
    super(
      '다른 실행(서버 발송 또는 다른 탭)이 이 캠페인 발송을 이어받아 브라우저 발송을 중단했습니다. 중복 발송 방지를 위해 상태를 확인한 뒤 진행해주세요.',
    )
    this.name = 'LeaseLostError'
  }
}

/** 토큰 refresh 자체 실패 — 수신자 문제가 아니므로 루프를 멈추고 남은 수신자를 보존. */
class TokenRefreshError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'TokenRefreshError'
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopToastMessage(reason: StopReason | 'incomplete', sent: number, remaining: number): string {
  const tail = `${sent}명 발송, ${remaining}명 대기`
  switch (reason) {
    case 'daily_quota':
      return `Gmail 일일 발송 한도 도달 — ${tail} (내일 '브라우저에서 재발송'으로 이어서 발송)`
    case 'rate_limit':
      return `Gmail 발송 속도 제한으로 중단 — ${tail} (잠시 후 '브라우저에서 재발송'으로 이어서 발송)`
    case 'auth':
      return `Google 인증 오류로 발송 중단 — ${tail} (재로그인 후 '브라우저에서 재발송')`
    case 'account':
      return `Gmail 계정 권한/정책 오류로 발송 중단 — ${tail} (Gmail 발송 권한·Workspace 관리자 정책 확인 후 재로그인하고 '브라우저에서 재발송')`
    case 'network':
      return `네트워크 오류/타임아웃이 반복되어 발송 중단 — ${tail} (결과 불확실 수신자는 Gmail 보낸편지함 확인, 연결 복구 후 '브라우저에서 재발송')`
    case 'record':
      return `발송 기록 저장 실패로 중단 — ${tail} (마지막 수신자는 이미 발송됐을 수 있어 재발송 대상에서 제외됨 · 네트워크 확인 후 '브라우저에서 재발송')`
    default:
      return `발송 미완료 — ${tail} ('브라우저에서 재발송'으로 이어서 발송)`
  }
}

/**
 * 캠페인 발송 완료 후 후속 시퀀스 등록 (followup_sequence_id 가 있고 1건 이상 발송됐을 때만).
 * RPC enroll_campaign_recipients 가 'sent' 수신자를 캠페인 스레드의 followup 으로 등록한다.
 * 실패해도 발송 자체는 성공이므로 경고만 — 등록은 멱등이라 재발송/재시도 시 복구 가능.
 */
async function enrollFollowupSequence(
  campaign: { followup_sequence_id?: string | null },
  campaignId: string,
  sentCount: number,
): Promise<number> {
  if (!campaign.followup_sequence_id || sentCount <= 0) return 0
  const { data, error } = await supabase.rpc('enroll_campaign_recipients', {
    p_campaign_id: campaignId,
  })
  if (error) {
    console.warn('[sendCampaign] follow-up enroll failed:', error.message)
    toast.warning(`후속 시퀀스 등록 실패 — 메일은 발송됨 (${error.message})`)
    return 0
  }
  return (data as unknown as number) ?? 0
}

/**
 * Google API 일시적 오류(429 rate limit, 5xx) exponential backoff 재시도.
 * 401(토큰 만료)/404(파일 없음)/403(권한 없음)/400(요청 오류) 은 재시도 대상 아님.
 * 클라이언트 타임아웃/네트워크 단절(timedOut/networkError)은 요청이 이미 처리됐을 수 있어
 * 절대 재시도하지 않는다 — messages.send 를 다시 부르면 중복 발송.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number
    baseMs?: number
    maxMs?: number
    label?: string
    isRetryable?: (e: unknown) => boolean
    /** 재시도 대기 직후(다음 시도 직전) 호출 — throw 하면 재시도를 중단한다 (lease 상실 등). */
    beforeRetry?: () => void
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseMs = 1000, maxMs = 10_000, label = 'api' } = opts
  const isRetryableFn = opts.isRetryable ?? defaultRetryable
  let attempt = 0

  while (true) {
    try {
      return await fn()
    } catch (e) {
      const status = (e as { status?: number }).status
      attempt++
      if (!isRetryableFn(e) || attempt >= maxAttempts) throw e
      const retryAfter = (e as GmailSendError).retryAfterMs
      const backoff = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1))
      const delay =
        (retryAfter != null && retryAfter <= maxMs ? Math.max(backoff, retryAfter) : backoff) +
        Math.random() * 250
      console.warn(
        `[retry:${label}] status=${status} attempt=${attempt}/${maxAttempts - 1} wait=${Math.round(delay)}ms`
      )
      await sleep(delay)
      opts.beforeRetry?.()
    }
  }
}

function defaultRetryable(e: unknown): boolean {
  const err = e as GmailSendError
  if (err?.timedOut || err?.networkError) return false
  const status = err?.status
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600)
}

// Gmail messages.send 전용 — 일일 한도 소진은 재시도해도 소용없고 계정 정지 위험만 키운다.
function gmailSendRetryable(e: unknown): boolean {
  const kind = classifyGmailError(e)
  if (kind === 'rate_limit') return true
  if (kind !== 'other') return false
  return defaultRetryable(e)
}

const GMAIL_SEND_RETRY = {
  maxAttempts: 4,
  baseMs: 2000,
  maxMs: 30_000,
  isRetryable: gmailSendRetryable,
}

/**
 * Google API 에러 → 한국어 사용자 메시지 매핑.
 * status 와 reason (error.errors[0].reason) 을 같이 본다.
 */
function mapGoogleError(e: unknown): string {
  const err = e as GmailSendError
  const status = err.status
  const msg = err.message ?? String(e)
  const lower = msg.toLowerCase()
  const reason = (err.reason ?? '').toLowerCase()

  if (e instanceof TokenRefreshError) return msg
  const kind = classifyGmailError(e)
  if (kind === 'timeout' || kind === 'network') return AMBIGUOUS_SEND_MESSAGE
  if (kind === 'daily_quota') return 'Gmail 일일 발송 한도 초과 — 내일 다시 발송해주세요.'
  if (kind === 'rate_limit') return 'Gmail 발송 속도 제한 초과 — 잠시 후 다시 시도해주세요.'
  if (kind === 'account') {
    if (status === 400)
      return 'Gmail 발송이 불가능한 계정입니다 (Mail service not enabled 등) — Google Workspace 관리자에게 Gmail 사용 설정을 확인해주세요.'
    return 'Gmail 발송 권한이 없거나 조직(도메인) 정책으로 차단되었습니다 — 재로그인 시 Gmail 발송 권한을 허용했는지, Workspace 관리자 정책을 확인해주세요.'
  }

  if (status === 401) return '인증이 만료되었습니다. 다시 로그인해주세요.'
  if (status === 403) {
    if (lower.includes('storagequotaexceeded') || reason === 'storagequotaexceeded')
      return 'Google Drive 용량이 부족합니다.'
    if (
      lower.includes('insufficientpermissions') ||
      lower.includes('insufficient') ||
      reason === 'insufficientpermissions'
    )
      return 'Drive/Gmail 권한이 부족합니다. 로그인 시 권한을 허용했는지 확인해주세요.'
    if (lower.includes('ratelimitexceeded')) return 'Google API 호출 한도 초과 — 잠시 후 다시 시도해주세요.'
    return '권한이 없습니다. (403)'
  }
  if (status === 404) return '파일을 찾을 수 없습니다. (Drive 에서 삭제됐을 수 있습니다)'
  if (status === 413) return '파일 크기가 너무 큽니다.'
  if (status === 429) return 'Google API 호출 한도 초과 — 잠시 후 다시 시도해주세요.'
  if (typeof status === 'number' && status >= 500) return `Google 서버 오류 (${status}) — 잠시 후 다시 시도해주세요.`
  return msg
}

function buildVariables(r: Recipient): Record<string, string> {
  const base: Record<string, string> = {
    email: r.email,
    name: r.name ?? '',
  }
  const v = r.variables as Record<string, unknown> | null
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      base[k] = val == null ? '' : String(val)
    }
  }
  return base
}

// ------------------------------------------------------------
// Drive 호출 + 401 자동 refresh + 429/5xx backoff 재시도 래퍼
// ------------------------------------------------------------
function makeDriveCaller(userId: string) {
  let token: string | null = null
  const ensure = async () => {
    if (!token) token = await getFreshGoogleToken(userId)
    return token
  }
  async function call<T>(fn: (tok: string) => Promise<T>): Promise<T> {
    // 이 call() 한 번당 refresh 는 최대 1회 — 연속 401 으로 인한 불필요한 refresh 루프 방지
    let refreshedThisCall = false
    return retryWithBackoff(
      async () => {
        const tok = await ensure()
        try {
          return await fn(tok)
        } catch (e) {
          const status = (e as { status?: number }).status
          if (status === 401 && !refreshedThisCall) {
            refreshedThisCall = true
            console.log('[sendCampaign] Drive 401 — refreshing token')
            token = await forceRefreshGoogleToken()
            return await fn(token)
          }
          throw e
        }
      },
      { label: 'drive' }
    )
  }
  return {
    call,
    current: () => token,
  }
}

// ------------------------------------------------------------
// 링크 fallback 시 본문에 추가할 다운로드 섹션
// ------------------------------------------------------------
function buildLinkSection(items: Array<{ filename: string; link: string; size: number | null }>): string {
  if (items.length === 0) return ''
  const listItems = items
    .map(
      (x) =>
        `<li style="margin:4px 0;"><a href="${escapeHtml(x.link)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;">${escapeHtml(x.filename)}</a>${
          x.size != null ? ` <span style="color:#6b7280;font-size:12px;">(${formatBytes(x.size)})</span>` : ''
        }</li>`
    )
    .join('')
  return `
<hr style="margin:24px 0;border:0;border-top:1px solid #e5e7eb;"/>
<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#111827;">
  <p style="margin:0 0 8px 0;"><strong>📎 첨부 파일</strong> <span style="color:#6b7280;font-size:12px;">(Google Drive 링크로 전달됩니다)</span></p>
  <ul style="padding-left:20px;margin:0;">${listItems}</ul>
</div>`.trim()
}

// ------------------------------------------------------------
// Phase 6 (C) — 오픈 추적 픽셀 주입
// ------------------------------------------------------------
// 수신자별로 고유 URL 을 만들어 HTML 본문 말미(</body> 직전) 에 삽입한다.
// </body> 가 없으면 그냥 뒤에 붙인다 — Gmail 은 대부분의 HTML 을 샌드박스로 감싸서
// 보여주므로 안전한 fallback.
//
//   bulk 모드는 수신자별 개인화가 불가능하므로 픽셀 주입을 건너뜀
//   (enable_open_tracking 이 true 여도 개인 식별 불가 — 추후 캠페인 단위
//    추적으로 확장 가능하지만 현재는 생략)
// ------------------------------------------------------------
const TRACK_OPEN_ENDPOINT =
  (import.meta.env.VITE_SUPABASE_URL as string) + '/functions/v1/track-open'

export function buildTrackingPixel(recipientId: string, campaignId: string): string {
  const url = `${TRACK_OPEN_ENDPOINT}?rid=${encodeURIComponent(recipientId)}&cid=${encodeURIComponent(campaignId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

// thread_messages (팔로업/회신/전달) 용 오픈 추적 픽셀.
// 같은 엔드포인트지만 tmid 파라미터만 — edge function 이 분기해서 track_thread_open RPC 호출.
export function buildThreadTrackingPixel(threadMessageId: string): string {
  const url = `${TRACK_OPEN_ENDPOINT}?tmid=${encodeURIComponent(threadMessageId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

export function injectTrackingPixel(html: string, pixelHtml: string): string {
  // </body> 태그가 있으면 그 앞에 삽입, 없으면 맨 뒤에.
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  }
  return html + pixelHtml
}

// ------------------------------------------------------------
// 079 — 수신거부 footer + List-Unsubscribe (send-scheduled-campaigns 와 동일 문구/로직)
// 정보통신망법 제50조 (본문 수신거부 방법 명시) + RFC 8058 one-click.
// 토큰은 recipients.unsubscribe_token (수신자별 capability).
//   - footer 링크(사람이 클릭) → GitHub Pages SPA 페이지 ${APP_BASE_URL}/unsubscribe?t=…
//     (*.supabase.co 는 text/html 을 text/plain 으로 내려 사람용 페이지를 띄울 수 없음 — C-2)
//   - List-Unsubscribe 헤더(메일 클라이언트 one-click POST) → Edge Function 직접
// ------------------------------------------------------------
const UNSUBSCRIBE_ENDPOINT =
  (import.meta.env.VITE_SUPABASE_URL as string) + '/functions/v1/unsubscribe'

/** SPA 기준 URL (끝 슬래시 없음) — 예: https://mk-amplitude.github.io/MailCaster_MK */
// D-3: window.location.origin 을 쓰면 dev/localhost 에서 보낸 메일의 링크가 실제 수신자에게
// localhost 로 나간다 — 배포 URL 을 env(VITE_APP_BASE_URL) 또는 고정 상수로만 만든다.
const DEFAULT_APP_BASE_URL = 'https://mk-amplitude.github.io/MailCaster_MK'
function appBaseUrl(): string {
  const env = ((import.meta.env.VITE_APP_BASE_URL as string | undefined) ?? '').trim()
  return (env || DEFAULT_APP_BASE_URL).replace(/\/+$/, '')
}

/** 본문 footer 의 '수신거부' 링크 — SPA 수신거부 확인 페이지. */
export function buildUnsubscribePageUrl(token: string | null | undefined): string | null {
  if (!token) return null
  return `${appBaseUrl()}/unsubscribe?t=${encodeURIComponent(token)}`
}

/** RFC 8058 List-Unsubscribe 헤더 URL — Edge Function 이 One-Click POST 를 직접 처리. */
export function buildOneClickUnsubscribeUrl(token: string | null | undefined): string | null {
  if (!token) return null
  return `${UNSUBSCRIBE_ENDPOINT}?t=${encodeURIComponent(token)}`
}

// url 이 없으면 (일괄 발송 — 한 통을 여럿이 받아 수신자별 토큰 불가) 회신 수신거부 안내.
// 회신의 수신거부 의사는 check-replies 가 감지해 unsubscribes 에 등록한다.
export function buildUnsubscribeFooter(url: string | null): string {
  const style = 'margin:24px 0 0 0;font-size:11px;line-height:1.5;color:#9ca3af;'
  if (url) {
    return `<p style="${style}">본 메일의 수신을 원하지 않으시면 <a href="${escapeHtml(url)}" style="color:#9ca3af;text-decoration:underline;">수신거부</a>를 눌러주세요.</p>`
  }
  return `<p style="${style}">본 메일의 수신을 원하지 않으시면 이 메일에 '수신거부'라고 회신해 주세요.</p>`
}

export function appendUnsubscribeFooter(html: string, footerHtml: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footerHtml}</body>`)
  }
  return html + footerHtml
}

function normalizeEmail(s: string): string {
  return (s ?? '').trim().toLowerCase()
}

// "Name <a@b.com>" → "a@b.com"
function extractAddress(addr: string): string {
  const m = (addr ?? '').match(/<([^>]+)>/)
  return m ? m[1] : (addr ?? '')
}

function isMissingRelation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(error.message ?? '')
  )
}

/**
 * 조직의 unsubscribes + blacklist 이메일(소문자) 집합 — send-scheduled-campaigns 의
 * loadSuppressedEmails 와 동일 규칙. PostgREST max_rows 가 1000 미만이어도 잘리지 않도록
 * 짧은 페이지가 아니라 "빈 페이지" 가 나올 때까지 읽는다 (C-7).
 * 조회 실패 시 throw — 수신거부 확인 없이 발송하지 않는다.
 */
async function loadSuppressedEmails(orgId: string | null, userId: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const table of ['unsubscribes', 'blacklist'] as const) {
    for (let offset = 0; ; ) {
      const base = supabase.from(table).select('id, email')
      const scoped = orgId ? base.eq('org_id', orgId) : base.eq('user_id', userId)
      const { data, error } = await scoped
        .order('id', { ascending: true })
        .range(offset, offset + SUPPRESSION_PAGE_SIZE - 1)
      if (error) {
        // blacklist 는 레거시 테이블 — 없어진 환경이면 무시 (서버와 동일)
        if (table === 'blacklist' && isMissingRelation(error)) break
        throw new Error(
          `수신거부 목록을 확인하지 못해 발송을 중단했습니다 (${table}: ${error.message}). 잠시 후 다시 시도해주세요.`,
        )
      }
      const rows = (data ?? []) as Array<{ email: string | null }>
      if (rows.length === 0) break
      for (const row of rows) {
        const e = normalizeEmail(row.email ?? '')
        if (e) out.add(e)
      }
      offset += rows.length
    }
  }
  return out
}

export function useSendCampaign() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ campaignId }: SendArgs) => {
      if (!user) throw new Error('로그인이 필요합니다.')

      // 1) 캠페인 로드
      const { data: campaign, error: cErr } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .single()
      if (cErr) throw cErr

      // 브라우저 발송은 "지금 로그인한 사람의 Gmail" 로 나간다. 작성자가 아닌 관리자가 실행하면
      // 발신자가 바뀌고, 답장/반송/수신거부 감지(check-replies 는 작성자 토큰으로 조회)가 끊긴다.
      if (campaign.user_id !== user.id) {
        throw new Error(
          '브라우저 발송은 캠페인 작성자 본인만 할 수 있습니다 (지금 로그인한 계정의 Gmail 로 발송되어 답장·반송 추적이 끊깁니다). 관리자는 "서버 발송"을 이용해주세요.',
        )
      }
      if (campaign.status === 'sending' && campaign.sending_started_at) {
        const leaseAge = Date.now() - new Date(campaign.sending_started_at).getTime()
        if (leaseAge < STUCK_LEASE_MS) {
          throw new Error(
            '다른 곳(서버 또는 다른 탭)에서 이 캠페인을 발송 중입니다. 잠시 후 상태를 확인해주세요.',
          )
        }
      }

      // 2) 유효한 Google access_token 확보 (만료됐으면 refresh_token으로 자동 갱신)
      let accessToken = await getFreshGoogleToken(user.id, TOKEN_MIN_VALIDITY_MS)
      let lastTokenCheckAt = Date.now()

      // 3) 발신자 표시 이름 — 서버 경로와 동일 우선순위 (default_sender_name → display_name),
      //    프로필 값이 없을 때만 OAuth 이름으로 fallback.
      const { data: senderProfile } = await supabase
        .from('profiles')
        .select('email, display_name, default_sender_name')
        .eq('id', user.id)
        .maybeSingle()

      // 4) 수신자 로드 — PostgREST max_rows(기본 1000)는 .range() 요청 크기와 무관하게 응답을
      //    자르므로 빈 페이지가 나올 때까지 페이지 단위로 끝까지 읽는다.
      //    (발송 전이라 pending 집합이 바뀌지 않으므로 offset 페이지네이션이 안정적)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawRecipients: any[] = []
      for (let offset = 0; ; ) {
        const { data: page, error: rErr } = await supabase
          .from('recipients')
          .select('*, contact:contacts(is_bounced, is_unsubscribed)')
          .eq('campaign_id', campaignId)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + RECIPIENT_PAGE_SIZE - 1)
        if (rErr) throw rErr
        if (!page || page.length === 0) break
        rawRecipients.push(...page)
        offset += page.length
      }

      // 서버 발송 경로(send-scheduled-campaigns)와 동일한 발송 직전 안전망 —
      // 캠페인 생성 후 수신거부/반송 처리된 연락처 + 조직 수신거부/차단 목록(주소 기준)을
      // 여기서 차단한다. contact 가 삭제됐거나 연결이 없는 수신자도 주소로 걸러진다.
      // (프리플라이트 다이얼로그가 약속하는 "수신거부 제외" 를 클라이언트 경로도 보장)
      // 목록 조회 실패 시 확인 못 한 채 발송하지 않는다 (loadSuppressedEmails 가 throw).
      const suppressed = await loadSuppressedEmails(campaign.org_id, campaign.user_id)
      type ContactFlags = { is_bounced: boolean | null; is_unsubscribed: boolean | null }
      const skippedByReason = new Map<string, string[]>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recipients = ((rawRecipients ?? []) as any[]).filter((r) => {
        const ct: ContactFlags | undefined = Array.isArray(r.contact) ? r.contact[0] : r.contact
        const reason = ct?.is_bounced
          ? '연락처가 반송 상태로 표시되어 발송 차단'
          : ct?.is_unsubscribed
            ? '연락처가 수신거부 상태로 발송 차단'
            : r.email && suppressed.has(normalizeEmail(r.email as string))
              ? '수신거부/차단 목록에 등록된 주소라 발송 차단'
              : null
        if (reason) {
          if (!skippedByReason.has(reason)) skippedByReason.set(reason, [])
          skippedByReason.get(reason)!.push(r.id as string)
          return false
        }
        return true
      }) as Database['mailcaster']['Tables']['recipients']['Row'][]
      // 차단된 행은 즉시 failed 처리 — 카운터/진행 표시에 잡히도록 (서버 경로와 동일 사유 문구).
      // .in('id', 대량) 은 URL 길이 한도에 걸리므로 100개씩 나눠 보내고 오류를 확인한다.
      // 마킹이 끝내 실패해도 해당 행은 위 필터로 이번 발송에서 제외되고 다음 실행에서 다시 걸러진다.
      let skipMarkFailed = 0
      for (const [reason, ids] of skippedByReason) {
        for (const idChunk of chunk(ids, SUPPRESS_UPDATE_CHUNK)) {
          let ok = false
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            if (attempt > 0) await sleep(500 * Math.pow(2, attempt - 1))
            const { error: skipErr } = await supabase
              .from('recipients')
              .update({ status: 'failed', error_message: reason })
              .eq('campaign_id', campaignId)
              .eq('status', 'pending')
              .in('id', idChunk)
            if (!skipErr) ok = true
            else console.warn('[sendCampaign] suppressed-recipient mark failed:', skipErr.message)
          }
          if (!ok) skipMarkFailed += idChunk.length
        }
      }
      if (skipMarkFailed > 0) {
        toast.warning(
          `수신거부/반송 수신자 ${skipMarkFailed}명의 상태 기록에 실패했습니다 — 발송에서는 제외됩니다.`,
        )
      }

      if (!recipients || recipients.length === 0) {
        throw new Error(
          skippedByReason.size > 0
            ? '모든 수신자가 수신거부/반송 상태라 발송할 대상이 없습니다.'
            : '발송할 수신자가 없습니다.',
        )
      }

      // 개인화 발송 — recipient 마다 자체 body_html_override 가 있으면 캠페인 레벨
      // body_html 은 비어있어도 OK. 모든 행에 override 가 있으면 빈 본문 체크 skip.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allHaveOverride = recipients.every((r: any) => {
        const v = r?.body_html_override
        return typeof v === 'string' && v.trim().length > 0
      })

      // 2-1) 본문 확정 — campaign.body_html 을 진실의 원천(source of truth)으로 사용.
      //   위저드가 저장 시점에 effectiveBody(= bodyOverride ?? composedHtml) 를 그대로 기록하므로
      //   여기서 재조합하면 Step 3 인라인 편집 결과가 silently 사라진다 (WYSIWYG 위반).
      //
      //   body_html 이 비어있는 legacy/코럽트 캠페인에 한해 방어적으로 블록에서 재조합한다.
      let finalBody: string = campaign.body_html ?? ''
      if (!finalBody.trim()) {
        console.warn('[sendCampaign] body_html empty — attempting fallback recompose from blocks')
        const { data: blocks, error: bErr } = await supabase
          .from('campaign_blocks')
          .select('template_id, position')
          .eq('campaign_id', campaignId)
          .order('position', { ascending: true })
        if (bErr) throw bErr
        if (blocks && blocks.length > 0) {
          const templateIds = blocks.map((b) => b.template_id as string)
          const { data: tpls, error: tErr } = await supabase
            .from('templates')
            .select('id, body_html')
            .in('id', templateIds)
          if (tErr) throw tErr
          const templateMap = new Map<string, string>(
            (tpls ?? []).map((t) => [t.id as string, (t.body_html as string) ?? ''])
          )
          const composedBody = blocks
            .map((b) => templateMap.get(b.template_id as string) ?? '')
            .filter(Boolean)
            .join('<br/><br/>')
          if (campaign.signature_id) {
            const { data: sig } = await supabase
              .from('signatures')
              .select('html')
              .eq('id', campaign.signature_id)
              .single()
            finalBody = sig?.html ? `${composedBody}<br/><br/>${sig.html}` : composedBody
          } else {
            finalBody = composedBody
          }
        }
      }

      if (!finalBody.trim() && !allHaveOverride) {
        throw new Error('발송할 본문이 비어있습니다. 템플릿 내용을 확인하세요.')
      }

      // 서명 fallback — body 에 서명이 정말 없을 때만 append.
      // 이전: finalBody.includes(sigHtml) 단순 비교 → TipTap 이 본문을 정규화하면
      //       HTML 미세 차이로 false 가 떨어져 서명이 중복 추가되던 버그.
      // 수정: HTML 태그 제거한 plain text 로 비교. 서명의 식별 fragment (보통 첫
      //       100자 — 이름/이메일 포함 영역) 가 본문에 있으면 이미 있다고 판단.
      if (campaign.signature_id && finalBody.trim()) {
        const { data: sig } = await supabase
          .from('signatures')
          .select('html')
          .eq('id', campaign.signature_id)
          .maybeSingle()
        const sigHtml = (sig?.html as string | undefined) ?? ''
        if (sigHtml && !bodyAlreadyContainsSignature(finalBody, sigHtml)) {
          finalBody = `${finalBody}<br/><br/>${sigHtml}`
        }
      }
      console.log('[sendCampaign] finalBody', { length: finalBody.length, source: 'body_html' })

      // 2-1.5) Inline 이미지 추출 — 본문의 <img src="..."> 를 fetch 해서 base64 로
      //         메일에 박는다. 결과: html 에 cid:xxx 형식의 src + inlineImages 배열.
      //         발송된 메일은 자기완결적 — Storage 가 사라져도 영구 표시 가능.
      //         외부 이미지 차단도 우회.
      const { html: bodyWithCids, images: inlineImages } = await extractAndInlineImages(
        finalBody,
      )
      finalBody = bodyWithCids
      if (inlineImages.length > 0) {
        console.log('[sendCampaign] inline images:', inlineImages.length)
      }

      // 2-2) 첨부 파일 로드
      const { data: camAtt, error: caErr } = await supabase
        .from('campaign_attachments')
        .select('sort_order, drive_attachments(*)')
        .eq('campaign_id', campaignId)
        .order('sort_order', { ascending: true })
      if (caErr) throw caErr
       
      const allAttachmentRows: DriveAttachmentRow[] = (camAtt ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.drive_attachments as DriveAttachmentRow)
        .filter(Boolean)

      const drive = makeDriveCaller(user.id)

      // 2-3) Preflight: 첨부 존재 확인 + 파일별 delivery_mode 결정 (send-scheduled-campaigns 의
      //      prepareAttachments 와 동일 규칙)
      //      - Google 문서/시트/슬라이드(vnd.google-apps.*) 와 크기 불명 파일 → 항상 link
      //        (alt=media 다운로드 불가). 이 파일 하나 때문에 나머지 PDF 등을 공개 링크로 바꾸지 않는다.
      //      - 나머지는 (원본 합계 + inline 이미지) ≤ 15MB 면 첨부, 초과면 전부 link.
      //      S4: 개별 404 는 skip 하고 나머지로 계속 진행. 모두 삭제됐으면 abort.
      //      S8: Blob 으로 보관 — JS heap 사용 최소화 (Uint8Array 중간 복사본 제거).
      const fileModes = new Map<string, 'attachment' | 'link'>() // attachment_id → mode
      const downloadedBlobs = new Map<string, Blob>() // attachment_id → Blob
      const linkRefs: Array<{ filename: string; link: string; size: number | null }> = []
      let attachmentRows: DriveAttachmentRow[] = allAttachmentRows

      if (attachmentRows.length > 0) {
        // 메타 재확인 — Drive 에서 삭제된 파일 감지, 개별 404 는 skip
        const skipped: string[] = []
        const alive: DriveAttachmentRow[] = []
        // Drive 실시간 메타 기준 크기/타입 (DB 값보다 우선 — 업로드 후 교체된 파일 대응)
        const liveMeta = new Map<string, { size: number | null; mimeType: string | null }>()
        for (const a of attachmentRows) {
          try {
            const meta = await drive.call((tok) => getFileMeta(tok, a.drive_file_id))
            liveMeta.set(a.id, { size: meta.size, mimeType: meta.mimeType })
            alive.push(a)
          } catch (e) {
            const status = (e as { status?: number }).status
            if (status === 404) {
              await supabase
                .from('drive_attachments')
                .update({ deleted_from_drive_at: new Date().toISOString() })
                .eq('id', a.id)
              skipped.push(a.file_name)
              console.warn(`[sendCampaign] skip deleted file: ${a.file_name}`)
            } else {
              throw new Error(mapGoogleError(e))
            }
          }
        }

        if (alive.length === 0 && allAttachmentRows.length > 0) {
          throw new Error(
            `첨부 파일이 모두 Drive 에서 삭제되었습니다 (${skipped.join(', ')}). 발송을 중단합니다.`
          )
        }
        if (skipped.length > 0) {
          // 일부만 삭제 — 토스트로 경고하지만 발송은 진행
          toast.warning(
            `일부 첨부 파일이 Drive 에서 삭제되어 제외됩니다: ${skipped.join(', ')}`
          )
        }

        attachmentRows = alive

        // 서버와 동일: 크기는 Drive 실시간 값 우선, 없으면 DB 캐시. 타입도 실시간 우선.
        const sizeOf = (a: DriveAttachmentRow): number | null => {
          const live = liveMeta.get(a.id)
          return live?.size ?? a.file_size ?? null
        }
        const forcedLink = (a: DriveAttachmentRow): boolean => {
          const mime = liveMeta.get(a.id)?.mimeType ?? a.mime_type ?? ''
          return sizeOf(a) == null || mime.startsWith('application/vnd.google-apps.')
        }
        const attachableBytes = attachmentRows
          .filter((a) => !forcedLink(a))
          .reduce((sum, a) => sum + (sizeOf(a) ?? 0), 0)
        // inline 이미지도 같은 메시지에 실리므로 합산 (base64 → 원본 바이트 환산)
        const inlineBytes = inlineImages.reduce((sum, img) => sum + Math.floor((img.base64.length * 3) / 4), 0)
        const attachOk = attachableBytes + inlineBytes <= CLIENT_ATTACHMENT_SAFE_THRESHOLD
        for (const a of attachmentRows) {
          fileModes.set(a.id, attachOk && !forcedLink(a) ? 'attachment' : 'link')
        }
        console.log('[sendCampaign] attachments', {
          count: attachmentRows.length,
          attachableBytes,
          inlineBytes,
          forcedLink: attachmentRows.filter(forcedLink).length,
          attachOk,
        })

        for (const a of attachmentRows) {
          if (fileModes.get(a.id) === 'attachment') {
            // 다운로드 (Blob 으로 캐시 — JS heap 사용 최소화)
            try {
              const blob = await drive.call((tok) => downloadFile(tok, a.drive_file_id))
              downloadedBlobs.set(a.id, blob)
            } catch (e) {
              throw new Error(mapGoogleError(e))
            }
            continue
          }
          // link 모드 — S2: 이미 public 공유된 파일은 cached web_view_link 재사용 (API 호출 생략)
          const size = sizeOf(a)
          if (a.is_public_shared && a.web_view_link) {
            linkRefs.push({ filename: a.file_name, link: a.web_view_link, size })
            continue
          }
          try {
            const link = await drive.call((tok) => shareAsPublicLink(tok, a.drive_file_id))
            linkRefs.push({ filename: a.file_name, link, size })
            await supabase
              .from('drive_attachments')
              .update({ is_public_shared: true, web_view_link: link })
              .eq('id', a.id)
          } catch (e) {
            throw new Error(mapGoogleError(e))
          }
        }

        // drive token refresh 동안 accessToken 도 동일하게 최신화
        const cur = drive.current()
        if (cur) accessToken = cur
      }

      const attachRowsForMime = attachmentRows.filter((a) => fileModes.get(a.id) === 'attachment')
      // 결과 토스트용 요약 — 링크로 간 파일이 하나라도 있으면 'link'
      const deliveryMode: 'attachment' | 'link' = linkRefs.length > 0 ? 'link' : 'attachment'

      // 링크 모드 파일이 있으면 본문에 섹션 append (개별/일괄 공통)
      const linkSection = buildLinkSection(linkRefs)

      // 3) 캠페인 상태 sending 으로 전환 — CAS(compare-and-set).
      //    W8) campaign.status 는 DbCampaignStatus union 이므로 그대로 사용.
      //    무조건 UPDATE 하면 두 탭(또는 예약발송 cron)이 동시에 같은 pending 수신자
      //    집합을 읽어 중복 발송됨 — 이미 'sending' 이면 여기서 중단.
      const previousStatus = campaign.status
      // sending_started_at(lease) 을 반드시 함께 찍는다 — 서버 cron 의 due 쿼리가
      // "sending + lease NULL" 을 고착 상태로 보고 즉시 가로채(복구 시도) 같은
      // 수신자에게 중복 발송하는 레이스가 있었음. lease 는 발송 루프에서 계속 갱신.
      //    이때 찍은 sending_started_at 값이 이 실행의 lease 토큰 — 이후 모든 갱신/해제는
      //    이 값을 조건으로 건 CAS 라서, 서버 cron 이 lease 를 가져가면 0행 갱신으로 감지된다.
      let leaseToken = new Date().toISOString()
      const { data: lockRows, error: lockErr } = await supabase
        .from('campaigns')
        .update({ status: 'sending', sending_started_at: leaseToken, last_error: null })
        .eq('id', campaignId)
        .neq('status', 'sending')
        .select('id')
      if (lockErr) throw lockErr
      if (!lockRows || lockRows.length === 0) {
        throw new Error('이미 다른 곳에서 이 캠페인을 발송 중입니다. 잠시 후 상태를 확인해주세요.')
      }
      qc.invalidateQueries({ queryKey: ['campaigns'] })

      // lease 갱신/해제는 heartbeat 와 루프가 동시에 부를 수 있어 직렬화한다 —
      // 같은 토큰으로 CAS 두 개가 겹치면 두 번째가 0행이 되어 lease 상실로 오판된다.
      let leaseLost = false
      // 최종/롤백 해제 후에는 heartbeat 가 lease 를 다시 찍지 않도록 (CAS 0행 → 상실 오판 방지)
      let leaseReleased = false
      let lastLeaseOkAt = Date.now()
      let leaseChain: Promise<unknown> = Promise.resolve()
      const withLease = <T,>(fn: () => Promise<T>): Promise<T> => {
        const p = leaseChain.then(fn, fn)
        leaseChain = p.catch(() => undefined)
        return p
      }
      // true = 아직 lease 소유. DB 일시 오류는 60초까지 관용 (그 이상이면 서버가 가져갔을 수 있음).
      const renewLease = (
        extra: Database['mailcaster']['Tables']['campaigns']['Update'] = {},
      ): Promise<boolean> =>
        withLease(async () => {
          if (leaseLost || leaseReleased) return false
          // 같은 ms 에 두 번 갱신되면 토큰이 같아져도 CAS 는 동작하지만, 단조 증가를 보장해 둔다.
          const nowMs = Date.now()
          const prevMs = Date.parse(leaseToken)
          const next = new Date(Number.isNaN(prevMs) || nowMs > prevMs ? nowMs : prevMs + 1).toISOString()
          const { data, error } = await supabase
            .from('campaigns')
            .update({ ...extra, sending_started_at: next })
            .eq('id', campaignId)
            .eq('status', 'sending')
            .eq('sending_started_at', leaseToken)
            .select('id')
          if (error) {
            console.warn('[sendCampaign] lease renew error:', error.message)
            if (Date.now() - lastLeaseOkAt > 60_000) {
              leaseLost = true
              stopHeartbeat()
            }
            return !leaseLost
          }
          if (!data || data.length === 0) {
            console.warn('[sendCampaign] lease lost — another runner owns this campaign')
            leaseLost = true
            stopHeartbeat()
            return false
          }
          leaseToken = next
          lastLeaseOkAt = Date.now()
          return true
        })
      // 캠페인 상태 해제 (최종/롤백) — lease 를 아직 소유할 때만 쓴다. true = 반영됨.
      // 호출 = 이 실행의 종료이므로 heartbeat 를 먼저 멈춘다 (해제 실패 시에도 lease 를 계속
      // 찍어 캠페인을 'sending' 으로 붙잡아 두지 않도록 — 그래야 서버 cron 이 이어받을 수 있다).
      const releaseCampaign = (
        update: Database['mailcaster']['Tables']['campaigns']['Update'],
      ): Promise<boolean> => {
        stopHeartbeat()
        const patch =
          update.status === 'failed' && !('last_error' in update)
            ? { ...update, last_error: BROWSER_STOPPED_REASON }
            : update
        return withLease(async () => {
          if (leaseLost || leaseReleased) return false
          const { data, error } = await supabase
            .from('campaigns')
            .update(patch)
            .eq('id', campaignId)
            .eq('sending_started_at', leaseToken)
            .select('id')
          if (error) {
            console.error('[sendCampaign] campaign release failed:', error.message)
            return false
          }
          if (!data || data.length === 0) {
            leaseLost = true
            return false
          }
          leaseReleased = true
          return true
        })
      }
      // 실행 전체 heartbeat — lock 직후부터 해제까지 30초마다 lease 갱신.
      // 긴 Gmail 업로드(최대 180초), 429/5xx 재시도 대기(최대 30초 × 3), 수신자 간 지연(최대 30초),
      // 결과 기록 재시도 등 어떤 대기 중에도 서버 due 쿼리의 90초 stale 판정에 걸리지 않는다.
      // (이전에는 단일 sendGmail 시도 동안만 돌아 대기 구간에서 lease 가 만료될 수 있었음)
      // 갱신 실패(다른 실행이 가져감)는 leaseLost 로 기록되고 루프/재시도가 즉시 중단한다.
      let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        void renewLease()
      }, LEASE_HEARTBEAT_MS)
      function stopHeartbeat() {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
      }
      // 재시도 대기 직후 — lease 를 잃었으면 같은 메시지를 다시 보내지 않고 중단.
      const abortIfLeaseLost = () => {
        if (leaseLost) throw new LeaseLostError()
      }

      const fromEmail = (senderProfile?.email as string | null | undefined) || user.email || ''
      const fromName =
        (senderProfile?.default_sender_name as string | null | undefined) ??
        (senderProfile?.display_name as string | null | undefined) ??
        user.user_metadata?.full_name ??
        user.user_metadata?.name ??
        ''
      const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail

      // 401 → 토큰 1회 refresh 후 같은 메시지 재시도. refresh 자체 실패는 TokenRefreshError.
      const sendWithAuth = async (args: Omit<Parameters<typeof sendGmail>[0], 'accessToken'>) => {
        let refreshed = false
        return retryWithBackoff(
          async () => {
            try {
              return await sendGmail({ ...args, accessToken })
            } catch (sendErr) {
              const status = (sendErr as { status?: number }).status
              if (status === 401 && !refreshed) {
                refreshed = true
                console.log('[sendCampaign] 401 detected, refreshing token')
                try {
                  accessToken = await forceRefreshGoogleToken()
                } catch (refreshErr) {
                  throw new TokenRefreshError(refreshErr)
                }
                lastTokenCheckAt = Date.now()
                if (leaseLost) throw new LeaseLostError()
                // 강제 refresh 후에도 401 이면 classifyGmailError → 'auth' 로 루프 중단 (C-6)
                return await sendGmail({ ...args, accessToken })
              }
              throw sendErr
            }
          },
          { ...GMAIL_SEND_RETRY, label: 'gmail', beforeRetry: abortIfLeaseLost },
        )
      }

      // 캠페인 레벨 CC / BCC (모든 메일에 동일하게 포함) — 서버와 동일하게 수신거부/차단 목록에
      // 있는 주소는 조용히 제외한다.
      const filterSuppressed = (list: unknown): string[] => {
        const arr = Array.isArray(list) ? (list as string[]) : []
        return arr.filter((addr) => {
          const blocked = suppressed.has(normalizeEmail(extractAddress(addr)))
          if (blocked) console.log('[sendCampaign] dropping suppressed cc/bcc address')
          return !blocked
        })
      }
      const campaignCc: string[] = filterSuppressed(campaign.cc)
      const campaignBcc: string[] = filterSuppressed(campaign.bcc)
      // C-4: CC/BCC 가 있으면 같은 메시지를 그들도 받으므로 수신자별 one-click 헤더를 넣지 않는다
      // (CC/BCC 수신자가 Gmail '구독 취소' 를 누르면 To 수신자가 수신거부됨). footer 링크는 유지 —
      // SPA 확인 페이지가 마스킹된 주소를 보여줘 본인 것이 아님을 알 수 있다.
      const allowOneClickHeader = campaignCc.length === 0 && campaignBcc.length === 0
      const sendMode: 'individual' | 'bulk' =
        (campaign.send_mode as 'individual' | 'bulk' | null) === 'bulk' ? 'bulk' : 'individual'
      // 079 — DB 기본값 true. 명시적으로 끈 캠페인만 수신거부 footer/헤더 생략.
      const includeUnsubscribe = campaign.include_unsubscribe_link !== false

      const delayMs = Math.max(0, (campaign.send_delay_seconds ?? 3) * 1000)
      let sent = 0
      let failed = 0

      // N3: 첨부 모드에서 재사용할 MailAttachment 배열.
      //     수신자마다 buildMime 안에서 blob → base64 재인코딩하던 것을 사전 1회 인코딩으로 축소.
      //     (N명 × FileReader → 1 × FileReader, 큰 첨부일수록 체감 큰 개선)
      //     인코딩 후 Blob 참조 해제 — base64 문자열만 유지해 중복 보관 방지.
      //
      // N4: 이 인코딩 단계는 아래 try/catch(abort rollback) 블록 바깥에 있으므로
      //     여기서 FileReader 가 실패하면 이미 'sending' 으로 변경된 campaign 상태가
      //     그대로 stuck 된다. 별도 try/catch 로 감싸 상태 복구 후 re-throw.
      let mailAttachments: MailAttachment[]
      try {
        mailAttachments =
          attachRowsForMime.length > 0
            ? await encodeAttachmentsForReuse(
                attachRowsForMime.map((a) => {
                  const blob = downloadedBlobs.get(a.id)
                  // 이 시점에 blob 이 없으면 preflight 로직 버그 — 안전장치로 빈 Blob 대체
                  // (사용자는 빈 첨부 발송 실패로 인지)
                  return {
                    filename: a.file_name,
                    mimeType: a.mime_type ?? 'application/octet-stream',
                    data: blob ?? new Blob(),
                  }
                })
              )
            : []
      } catch (encErr) {
        console.error('[sendCampaign] attachment encoding failed:', encErr)
        await releaseCampaign({ status: previousStatus, sending_started_at: null })
        qc.invalidateQueries({ queryKey: ['campaigns'] })
        throw new Error(
          `첨부 파일 인코딩 실패: ${encErr instanceof Error ? encErr.message : String(encErr)}`
        )
      }
      downloadedBlobs.clear()

      // 처음 성공한 순간 파일별 delivery_mode 를 DB 에 기록 (S1 + N1) — 모드별 일괄 UPDATE
      let deliveryModePersisted = false
      const persistDeliveryMode = async () => {
        if (deliveryModePersisted || attachmentRows.length === 0) return
        for (const mode of ['attachment', 'link'] as const) {
          const ids = attachmentRows.filter((a) => fileModes.get(a.id) === mode).map((a) => a.id)
          if (ids.length === 0) continue
          const { error: dmErr } = await supabase
            .from('campaign_attachments')
            .update({ delivery_mode: mode })
            .eq('campaign_id', campaignId)
            .in('attachment_id', ids)
          if (dmErr) {
            console.warn('[sendCampaign] delivery_mode update failed:', dmErr)
          }
        }
        deliveryModePersisted = true
      }

      // ============================================================
      // BULK 모드 — Gmail API 1회 호출로 수신자 전원에게 단체 발송.
      //   - 수신자 전원이 To 헤더에 comma-separated 로 들어감 (서로의 주소가 보임).
      //   - 개인화 변수({{name}}, {{company}} 등)는 치환되지 않으므로 미리 검증해 차단.
      //   - send_delay_seconds 는 의미 없음 (단일 요청).
      //   - 성공 시 recipients 전원을 동일한 gmail_message_id 로 'sent' 일괄 기록.
      //   - 실패 시 전원 'failed'.
      // ============================================================
      if (sendMode === 'bulk') {
        // 개인화 오버라이드가 있는 수신자가 한 명이라도 있으면 BULK 발송 차단.
        // BULK 는 단일 메일 1통이라 사람별 본문을 표현할 수 없음 — 개인화가 silently 손실됨.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasPersonalizedOverride = recipients.some((r: any) => {
          const s = (r?.subject_override as string | null | undefined)?.trim()
          const b = (r?.body_html_override as string | null | undefined)?.trim()
          return !!s || !!b
        })
        if (hasPersonalizedOverride) {
          await releaseCampaign({ status: previousStatus, sending_started_at: null })
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          throw new Error(
            '일괄 발송 모드인데 일부 수신자에 AI 개인화 본문이 저장돼 있습니다. 개별 발송 모드로 전환하세요.'
          )
        }

        const rawSubject = campaign.subject ?? ''
        // bulk 에서는 수신자별 variables 치환이 불가능하므로 모든 {{...}} 변수는 차단 대상.
        // (개별 모드에서만 buildVariables/renderTemplate 이 돌아간다)
        const subjectVars = extractVariables(rawSubject)
        const bodyVars = extractVariables(finalBody)
        const allVars = Array.from(new Set([...subjectVars, ...bodyVars]))
        if (allVars.length > 0) {
          // 상태를 원복 후 에러 — 이미 'sending' 으로 바뀌어 있으므로 복구해야 함
          await releaseCampaign({ status: previousStatus, sending_started_at: null })
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          throw new Error(
            `일괄 발송 모드에서는 개인화 변수를 사용할 수 없습니다. 제목/본문에서 제거해주세요: ${allVars
              .map((v) => `{{${v}}}`)
              .join(', ')}`
          )
        }

        // 수신자 이메일 전원을 comma-separated 단일 To 헤더로 구성 — 서로가 보임
        const toList = recipients.map((r) => (r as Recipient).email)
        // Gmail 요청당 수신자 총합(To+Cc+Bcc) 상한은 ~500. 초과 시 선제 차단.
        const totalAddresses = toList.length + campaignCc.length + campaignBcc.length
        if (totalAddresses > 500) {
          await releaseCampaign({ status: previousStatus, sending_started_at: null })
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          throw new Error(
            `일괄 발송 수신자 합계가 ${totalAddresses}명으로 Gmail 상한(500)을 초과합니다. 개별 발송 모드를 사용하거나 수신자를 줄여주세요.`
          )
        }

        // 링크 모드면 본문에 링크 섹션 append (개별 모드와 동일)
        const bodyWithLinks = linkSection ? `${finalBody}${linkSection}` : finalBody
        // 079 — 수신자별 토큰 불가 → 회신 수신거부 안내 footer (List-Unsubscribe 헤더 없음)
        const html = includeUnsubscribe
          ? appendUnsubscribeFooter(bodyWithLinks, buildUnsubscribeFooter(null))
          : bodyWithLinks
        const bulkTo = toList.join(', ')

        // 발송 전 전원 선점(pending → sending, CAS) — 서버 bulk 경로와 동일.
        // 선점 없이 보내면 Gmail 호출 도중 탭 종료/크래시 시 행이 전부 pending 으로 남아
        // 다음 재발송이 최대 500명에게 같은 메일을 한 번 더 보낸다.
        const bulkIds = recipients.map((r) => (r as Recipient).id)
        const claimedIds: string[] = []
        for (const idChunk of chunk(bulkIds, SUPPRESS_UPDATE_CHUNK)) {
          const { data: claimed, error: claimErr } = await supabase
            .from('recipients')
            .update({ status: 'sending' })
            .eq('campaign_id', campaignId)
            .in('id', idChunk)
            .eq('status', 'pending')
            .is('gmail_message_id', null)
            .select('id')
          if (claimErr) break
          for (const c of claimed ?? []) claimedIds.push(c.id as string)
        }
        const revertClaimed = async () => {
          // bulkIds 기준 — UPDATE 는 커밋됐는데 응답만 유실된 청크도 되돌린다 (status='sending' 조건이라 안전)
          for (const idChunk of chunk(bulkIds, SUPPRESS_UPDATE_CHUNK)) {
            await supabase
              .from('recipients')
              .update({ status: 'pending' })
              .eq('campaign_id', campaignId)
              .in('id', idChunk)
              .eq('status', 'sending')
          }
        }
        if (claimedIds.length !== bulkIds.length) {
          await revertClaimed()
          await releaseCampaign({ status: previousStatus, sending_started_at: null })
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          throw new Error(
            '수신자 상태가 발송 도중 바뀌어 일괄 발송을 시작하지 않았습니다. 새로고침 후 다시 시도해주세요.',
          )
        }

        try {
          const result = await sendWithAuth({
            from,
            to: bulkTo, // 수신자 전원 노출 — 서로의 이메일이 To 에 보임
            subject: rawSubject,
            html,
            attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
            inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
            cc: campaignCc.length > 0 ? campaignCc : undefined,
            bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
          })

          // 전원 sent 로 일괄 업데이트 — 공통 gmail_message_id 기록
          const nowIso = new Date().toISOString()
          // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — bulk 는 1통이므로 공통 rfc.
          const bulkRfc = campaign.followup_sequence_id
            ? await fetchMessageRfcId(accessToken, result.id)
            : null
          const sentPatch = {
            status: 'sent' as const,
            sent_at: nowIso,
            gmail_message_id: result.id,
            gmail_thread_id: result.threadId,
            rfc_message_id: bulkRfc,
            error_message: null,
          }
          let bulkRecordFailed = false
          for (const idChunk of chunk(claimedIds, SUPPRESS_UPDATE_CHUNK)) {
            let ok = false
            for (let attempt = 0; attempt < 3 && !ok; attempt++) {
              if (attempt > 0) await sleep(500 * Math.pow(2, attempt - 1))
              const { error: e1 } = await supabase
                .from('recipients')
                .update(sentPatch)
                .eq('campaign_id', campaignId)
                .in('id', idChunk)
                .eq('status', 'sending')
              // lease 를 잃은 사이 서버가 '결과 불확실'로 정리한 행 — Gmail 이 실제로 보냈으므로 바로잡는다.
              const { error: e2 } = e1
                ? { error: e1 }
                : await supabase
                    .from('recipients')
                    .update(sentPatch)
                    .eq('campaign_id', campaignId)
                    .in('id', idChunk)
                    .eq('status', 'failed')
                    .eq('error_message', AMBIGUOUS_SEND_MESSAGE)
                    .is('gmail_message_id', null)
              ok = !e1 && !e2
              if (!ok) console.warn('[sendCampaign:bulk] recipients sent update failed:', e1 ?? e2)
            }
            if (!ok) bulkRecordFailed = true
          }
          if (bulkRecordFailed) {
            toast.warning(
              '메일은 발송됐지만 일부 수신자의 발송 기록 저장에 실패했습니다. 해당 수신자는 "발송 중"으로 보일 수 있으며 다시 발송되지 않습니다.',
              { duration: 15000 },
            )
          }

          sent = recipients.length

          await persistDeliveryMode()

          // recipient_attachments 이력 — 전원에게 동일 내용
          if (attachmentRows.length > 0) {
            const historyRows: Array<Record<string, unknown>> = []
            for (const rr of recipients) {
              const r = rr as Recipient
              for (const a of attachmentRows) {
                historyRows.push({
                  user_id: user.id,
                  attachment_id: a.id,
                  recipient_id: r.id,
                  campaign_id: campaignId,
                  recipient_email: r.email,
                  recipient_name: r.name,
                  campaign_name: campaign.name,
                  delivery_mode: fileModes.get(a.id) ?? 'attachment',
                  sent_at: nowIso,
                })
              }
            }
            const { error: histErr } = await supabase
              .from('recipient_attachments')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .insert(historyRows as any)
            if (histErr) {
              console.warn('[sendCampaign:bulk] recipient_attachments insert failed:', histErr)
              toast.warning(`발송 이력 기록 실패 — 메일은 전송됨 (${histErr.message})`)
            }
          }

          // 카운터는 DB 재집계 — 부분 발송 후 bulk 로 바꿔 재발송한 캠페인의 이전 누적을 보존.
          const [bulkSentCnt, bulkFailedCnt] = await Promise.all([
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId)
              .eq('status', 'sent'),
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId)
              .eq('status', 'failed'),
          ])
          const released = await releaseCampaign({
            status: 'sent',
            sent_count: Math.max(bulkSentCnt.count ?? 0, bulkRecordFailed ? claimedIds.length : 0) || sent,
            failed_count: bulkFailedCnt.count ?? 0,
            sending_started_at: null,
            last_processed_recipient_id: null,
            send_attempts: 0,
            last_error: null,
          })
          if (!released) {
            console.warn('[sendCampaign:bulk] lease lost before final status write')
          }

          // 후속 시퀀스 등록 — 발송 성공한 수신자를 캠페인 스레드 followup 으로 이어간다.
          const enrolled = await enrollFollowupSequence(campaign, campaignId, sent)

          qc.invalidateQueries({ queryKey: ['campaigns'] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          qc.invalidateQueries({ queryKey: ['attachment_stats'] })
          if (enrolled > 0) qc.invalidateQueries({ queryKey: ['sequences'] })

          return {
            sent,
            failed: 0,
            total: recipients.length,
            deliveryMode,
            enrolled,
            remaining: 0,
            campaignSent: sent,
            stopReason: null as StopReason | null,
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const friendly = mapGoogleError(e)
          console.error('[sendCampaign:bulk] failed:', msg)
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          // 다른 실행이 캠페인을 가져갔으면 상태를 건드리지 않는다.
          if (leaseLost) throw new LeaseLostError()
          const kind: GmailErrorKind =
            e instanceof TokenRefreshError ? 'auth' : classifyGmailError(e)
          if (
            kind === 'daily_quota' ||
            kind === 'rate_limit' ||
            kind === 'auth' ||
            kind === 'account'
          ) {
            // Gmail 이 거부 = 발송 안 됨 — 선점한 행을 pending 으로 되돌리고 캠페인만 재개 가능 상태로.
            await revertClaimed()
            await releaseCampaign({ status: 'failed', sending_started_at: null, last_error: friendly })
            throw new Error(
              `${friendly} — 수신자 ${recipients.length}명은 대기 상태로 남아 '브라우저에서 재발송'으로 다시 보낼 수 있습니다.`,
            )
          }
          // 그 외(타임아웃 포함 — 이미 발송됐을 수 있어 pending 으로 두면 재발송 시 중복) 선점 행 전원 failed.
          for (const idChunk of chunk(claimedIds, SUPPRESS_UPDATE_CHUNK)) {
            await supabase
              .from('recipients')
              .update({ status: 'failed', error_message: friendly })
              .eq('campaign_id', campaignId)
              .in('id', idChunk)
              .eq('status', 'sending')
          }
          const [fSent, fFailed] = await Promise.all([
            supabase.from('recipients').select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId).eq('status', 'sent'),
            supabase.from('recipients').select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId).eq('status', 'failed'),
          ])
          await releaseCampaign({
            status: 'failed',
            ...(fSent.count != null ? { sent_count: fSent.count } : {}),
            failed_count: fFailed.count ?? recipients.length,
            sending_started_at: null,
            last_error: friendly,
          })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          throw new Error(friendly)
        }
      }

      // ============================================================
      // INDIVIDUAL 모드 (기본) — 수신자별 루프
      // ============================================================
      // 수신자 결과 기록 UPDATE 재시도 — Gmail 은 이미 발송했으므로 기록이 빠지면 재개 시 중복 발송.
      // onlyFromStatus 지정 시 그 상태인 행만 갱신 (pending 복귀는 'sending' 행에만).
      const markSent = async (
        recipientId: string,
        payload: Database['mailcaster']['Tables']['recipients']['Update'],
        onlyFromStatus?: 'sending',
      ): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await sleep(500 * Math.pow(2, attempt - 1))
          let q = supabase.from('recipients').update(payload).eq('id', recipientId)
          if (onlyFromStatus) q = q.eq('status', onlyFromStatus)
          const { error } = await q
          if (!error) return true
          console.warn('[sendCampaign] sent-status update failed:', error.message)
        }
        return false
      }
      // head-count (일시 오류 1회 재시도). null = 집계 실패.
      const countBy = async (
        build: () => PromiseLike<{ count: number | null; error: unknown }>,
      ): Promise<number | null> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const { count, error } = await build()
          if (!error && count != null) return count
          if (attempt === 0) await sleep(1000)
        }
        return null
      }

      let stopReason: StopReason | null = null
      let consecutiveAmbiguous = 0
      let claimedNotSentId: string | null = null
      // C2 + C3: try/catch/finally — abort 시 campaign 상태 rollback + stuck recipient 정리
      try {
        for (let i = 0; i < recipients.length; i++) {
          const r = recipients[i] as Recipient
          if (leaseLost) throw new LeaseLostError()

          // 장시간 루프 — Google 토큰 선제 갱신 (만료 직전 401 → refresh 경합을 줄임)
          if (Date.now() - lastTokenCheckAt > TOKEN_CHECK_INTERVAL_MS) {
            try {
              accessToken = await getFreshGoogleToken(user.id, TOKEN_MIN_VALIDITY_MS)
              lastTokenCheckAt = Date.now()
            } catch (tokErr) {
              console.error('[sendCampaign] token refresh failed — stopping:', tokErr)
              stopReason = 'auth'
              break
            }
          }

          // pending → sending CAS — 다른 실행이 이미 집어간 행은 건너뛴다.
          let claim = await supabase
            .from('recipients')
            .update({ status: 'sending' })
            .eq('id', r.id)
            .eq('status', 'pending')
            .select('id')
          if (claim.error) {
            await sleep(1000)
            claim = await supabase
              .from('recipients')
              .update({ status: 'sending' })
              .eq('id', r.id)
              .eq('status', 'pending')
              .select('id')
          }
          if (claim.error) throw claim.error
          if (!claim.data || claim.data.length === 0) {
            console.warn('[sendCampaign] recipient no longer pending — skip:', r.id)
            continue
          }
          // Gmail 호출 전까지만 설정 — abort 시 pending 으로 되돌려도 안전한(아직 안 보낸) 행.
          claimedNotSentId = r.id

          try {
            const vars = buildVariables(r)
            // 개인화 모드 — recipients 행에 자체 subject/body 오버라이드가 있으면 그대로 사용.
            // (LLM 이 사람마다 직접 작성한 문장이라 템플릿 변수 치환 X)
            // 빈 문자열은 null 처럼 취급 — '' 가 들어 있으면 빈 제목/본문으로 발송될 위험.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ovr = r as any as { subject_override?: string | null; body_html_override?: string | null }
            const subjOverride = ovr.subject_override?.trim() ? ovr.subject_override : null
            const bodyOverride = ovr.body_html_override?.trim() ? ovr.body_html_override : null
            const subject = subjOverride ?? renderTemplate(campaign.subject ?? '', vars)
            // 본문은 HTML 컨텍스트 — 연락처 필드(name/company 등)에 HTML 이 섞여 있어도
            // 태그로 해석되지 않도록 이스케이프 치환 사용 (XSS/레이아웃 깨짐 방지)
            const renderedBody = bodyOverride ?? renderTemplateHtml(finalBody, vars)
            const htmlWithLinks = linkSection ? `${renderedBody}${linkSection}` : renderedBody
            // 079 — 수신거부 footer. 토큰 없는 행(마이그레이션 전 배포 등)은 회신 안내로 대체.
            //   footer 링크 = SPA 페이지, List-Unsubscribe 헤더 = Edge Function (C-2)
            const unsubPageUrl = includeUnsubscribe
              ? buildUnsubscribePageUrl(r.unsubscribe_token)
              : null
            const oneClickUrl =
              includeUnsubscribe && allowOneClickHeader
                ? buildOneClickUnsubscribeUrl(r.unsubscribe_token)
                : null
            const withFooter = includeUnsubscribe
              ? appendUnsubscribeFooter(htmlWithLinks, buildUnsubscribeFooter(unsubPageUrl))
              : htmlWithLinks
            // Phase 6 (C) — 오픈 추적 픽셀 주입 (캠페인 설정이 enable 이고 수신자 id 가 있을 때)
            const html = campaign.enable_open_tracking
              ? injectTrackingPixel(withFooter, buildTrackingPixel(r.id, campaignId))
              : withFooter
            // 401 → 토큰 1회 refresh, 일시적 429/5xx → bounded backoff, 타임아웃은 재시도 안 함
            // (미참조 inline 이미지는 buildMime 이 제외)
            // 이 시점부터 결과는 inner catch 가 기록한다 — abort cleanup 이 pending 으로 되돌리면 안 됨.
            claimedNotSentId = null
            const result = await sendWithAuth({
              from,
              to: r.email,
              toName: r.name,
              subject,
              html,
              attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
              inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
              cc: campaignCc.length > 0 ? campaignCc : undefined,
              bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
              listUnsubscribeUrl: oneClickUrl,
            })

            // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — followup In-Reply-To 용.
            const rfcMessageId = campaign.followup_sequence_id
              ? await fetchMessageRfcId(accessToken, result.id)
              : null
            const recorded = await markSent(r.id, {
              status: 'sent',
              sent_at: new Date().toISOString(),
              gmail_message_id: result.id,
              gmail_thread_id: result.threadId,
              rfc_message_id: rfcMessageId,
              error_message: null,
            })
            if (!recorded) {
              // Gmail 은 이미 발송함 — 이 행은 'sending' 으로 남겨 두고(pending 으로 되돌리면 재발송)
              // 서버 경로와 동일하게 루프를 멈춘다. DB 가 불안정한 상태로 계속 보내면 기록 없는
              // 발송(=중복 발송 위험 행)만 늘어난다.
              console.error('[sendCampaign] sent but not recorded — stopping:', r.id, result.id)
              toast.warning(`${r.email} 발송됨 — 발송 기록 저장 실패 (Gmail id ${result.id})`)
              sent++
              consecutiveAmbiguous = 0
              stopReason = 'record'
              break
            }

            // S1: 첫 성공 시점에 delivery_mode DB 기록 (preflight 단계가 아니라)
            await persistDeliveryMode()

            // recipient_attachments — 발송 이력 기록 (denormalize 로 추적성 보존)
            // recipient_id FK 는 mailcaster.recipients(id) 를 가리킴 — contact_id 아님!
            if (attachmentRows.length > 0) {
              const historyRows = attachmentRows.map((a) => ({
                user_id: user.id,
                attachment_id: a.id,
                recipient_id: r.id,
                campaign_id: campaignId,
                recipient_email: r.email,
                recipient_name: r.name,
                campaign_name: campaign.name,
                delivery_mode: fileModes.get(a.id) ?? 'attachment',
                sent_at: new Date().toISOString(),
              }))
              const { error: histErr } = await supabase
                .from('recipient_attachments')
                .insert(historyRows)
              if (histErr) {
                // 이력 기록 실패해도 발송은 성공 — 경고 + 사용자 토스트 (S3)
                console.warn('[sendCampaign] recipient_attachments insert failed:', histErr)
                toast.warning(
                  `${r.email} 발송 이력 기록 실패 — 메일은 전송됨 (${histErr.message})`
                )
              }
            }

            sent++
            consecutiveAmbiguous = 0
          } catch (e) {
            // 재시도 대기 중 lease 를 잃음 — 상태를 건드리지 않고 바깥에서 중단 처리.
            // (재시도 대상은 Gmail 이 429/5xx 로 거부한 것이라 이 행은 발송되지 않았다)
            if (e instanceof LeaseLostError) throw e
            const msg = e instanceof Error ? e.message : String(e)
            const kind: GmailErrorKind =
              e instanceof TokenRefreshError ? 'auth' : classifyGmailError(e)
            console.error('[sendCampaign] recipient failed:', r.email, kind, msg)
            if (
              kind === 'daily_quota' ||
              kind === 'rate_limit' ||
              kind === 'auth' ||
              kind === 'account'
            ) {
              // Gmail 이 거부 = 이 수신자도 발송 안 됨. pending 으로 되돌리고 즉시 중단 —
              // 한도 소진/계정 단위 거부(C-6) 후 계속 호출하면 남은 전원이 failed 로 박제되고
              // 계정 정지 위험. 캠페인은 아래 최종 처리에서 남은 pending 때문에 'failed' 로 닫힌다.
              const ok = await markSent(r.id, { status: 'pending', error_message: null }, 'sending')
              if (!ok) console.error('[sendCampaign] revert-to-pending failed:', r.id)
              stopReason = kind
              break
            }
            // C-5: 결과 불명(타임아웃/연결 끊김)은 재시도도 pending 복귀도 하지 않는다 (재발송 = 중복).
            //      failed + 고정 문구로 남기고 다음 수신자로 계속 — 사용자가 보낸편지함에서 확인.
            const ambiguous = kind === 'timeout' || kind === 'network'
            const friendly = ambiguous ? AMBIGUOUS_SEND_MESSAGE : mapGoogleError(e)
            const ok = await markSent(r.id, { status: 'failed', error_message: friendly })
            if (!ok) console.error('[sendCampaign] failed-status update failed:', r.id)
            failed++
            if (ambiguous) {
              consecutiveAmbiguous++
              // 연속으로 결과 불명이면 연결 자체가 끊긴 것(오프라인 등) — 남은 수신자까지
              // '불확실' 로 박제하지 않도록 여기서 멈춘다. 남은 수신자는 시도 전이라 pending 유지.
              if (
                consecutiveAmbiguous >= MAX_CONSECUTIVE_AMBIGUOUS ||
                (typeof navigator !== 'undefined' && navigator.onLine === false)
              ) {
                stopReason = 'network'
                break
              }
            } else {
              consecutiveAmbiguous = 0
            }
          }
          claimedNotSentId = null

          // sending_started_at 갱신 = 서버 cron 의 90초 lease 연장 (CAS) —
          // 0행이면 서버/다른 탭이 가져간 것이므로 즉시 중단.
          const stillOwner = await renewLease({ sent_count: sent, failed_count: failed })
          if (!stillOwner) throw new LeaseLostError()
          // invalidate 는 10명마다 1회 — 매 수신자마다 하면 active 쿼리가 그때마다
          // recipients 전체(개인화 override 포함)를 재요청해 발송 내내
          // 수 GB 급 전송이 발생. 진행 표시는 useCampaignRecipients 의 2초 폴링이 담당.
          if ((i + 1) % 10 === 0) {
            qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
            qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          }

          if (i < recipients.length - 1 && delayMs > 0) {
            await sleep(delayMs)
          }
        }
        if (leaseLost) throw new LeaseLostError()

        // 4) 최종 상태 처리 — 카운터는 이번 run 값이 아니라 DB 재집계로 확정.
        //    (부분 발송 후 재개 run 이 이전 누적을 덮어써 통계가 어긋나던 버그 방지 —
        //     서버 경로의 최종 COUNT 재계산과 동일한 방식)
        //    미발송(pending/sending + gmail_message_id NULL)이 남아 있으면 절대 'sent' 로 닫지 않는다
        //    — 'sent' 는 재발송 버튼을 숨기고 cron 도 집지 않아 남은 수신자가 영구 고립된다.
        const [sentCnt, failedCnt, remainingCnt] = await Promise.all([
          countBy(() =>
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId)
              .eq('status', 'sent'),
          ),
          countBy(() =>
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId)
              .eq('status', 'failed'),
          ),
          countBy(() =>
            supabase
              .from('recipients')
              .select('id', { count: 'exact', head: true })
              .eq('campaign_id', campaignId)
              .in('status', ['pending', 'sending'])
              .is('gmail_message_id', null),
          ),
        ])
        const doneSent = sentCnt ?? sent
        const doneFailed = failedCnt ?? failed
        // 집계 실패 시 남은 수신자가 있다고 가정 — 잘못 'sent' 로 닫는 것보다 재개 가능 상태가 안전.
        const remaining = remainingCnt ?? Math.max(1, recipients.length - sent - failed)
        const finalStatus =
          remainingCnt == null || remaining > 0 || doneSent === 0 ? 'failed' : 'sent'
        const released = await releaseCampaign({
          status: finalStatus,
          sent_count: doneSent,
          failed_count: doneFailed,
          sending_started_at: null,
          last_processed_recipient_id: null,
          send_attempts: 0,
          ...(finalStatus === 'sent' ? { last_error: null } : {}),
        })
        if (!released) {
          console.warn('[sendCampaign] final status write skipped (lease lost or DB error)')
        }
        qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
        qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })

        // 후속 시퀀스 등록 — 발송 성공한 수신자를 캠페인 스레드 followup 으로 이어간다.
        const enrolled = await enrollFollowupSequence(campaign, campaignId, sent)

        qc.invalidateQueries({ queryKey: ['attachment_stats'] })
        if (enrolled > 0) qc.invalidateQueries({ queryKey: ['sequences'] })

        return {
          sent,
          failed,
          total: recipients.length,
          deliveryMode,
          enrolled,
          remaining,
          campaignSent: doneSent,
          stopReason,
        }
      } catch (abortErr) {
        // lease 를 잃었으면 다른 실행이 캠페인/수신자 상태를 소유 — 아무것도 되돌리지 않는다.
        if (abortErr instanceof LeaseLostError) {
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          throw abortErr
        }
        // C2: 루프 외부에서 발생한 abort — campaign 상태 복원
        //     일부 보내졌으면 'failed' (부분 성공), 하나도 못 보냈으면 previousStatus 로 복귀
        console.error('[sendCampaign] aborted mid-send:', abortErr)
        const rollbackStatus = sent > 0 ? 'failed' : previousStatus
        // N2: 루프가 한 번도 돌지 않은 채 abort 된 경우 sent_count/failed_count 를 덮어쓰면
        //     이전 발송 이력(재발송 시 previousStatus='failed' 캠페인의 누적 카운트)이 0 으로
        //     소실된다. 최소 1건이라도 처리됐을 때만 카운트를 갱신.
        const rollbackUpdate: Database['mailcaster']['Tables']['campaigns']['Update'] = {
          status: rollbackStatus,
          sending_started_at: null,
        }
        if (sent + failed > 0) {
          rollbackUpdate.sent_count = sent
          rollbackUpdate.failed_count = failed
        }
        const released = await releaseCampaign(rollbackUpdate)

        // C3: 이 실행이 claim 했지만 Gmail 호출 전에 중단된 행만 'pending' 으로 복구 — 아직
        //     lease 소유자일 때만. 캠페인 전체의 'sending' 행을 되돌리면 이전 실행에서 Gmail 이
        //     이미 받았지만 기록에 실패한 행(결과 불명)까지 pending 이 되어 중복 발송된다.
        if (released && claimedNotSentId) {
          const { error: cleanupErr } = await supabase
            .from('recipients')
            .update({
              status: 'pending',
              error_message: '발송이 중단되었습니다.',
            })
            .eq('id', claimedNotSentId)
            .eq('status', 'sending')
            .is('gmail_message_id', null)
          if (cleanupErr) {
            console.error('[sendCampaign] cleanup failed:', cleanupErr)
          }
        }

        qc.invalidateQueries({ queryKey: ['campaigns'] })
        qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
        qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })

        throw abortErr
      }
    },
    onSuccess: ({ sent, failed, total, deliveryMode, enrolled, remaining, campaignSent, stopReason }) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      // 캠페인 발송 결과 (recipients) 를 공유하는 뷰들 즉시 갱신 — thread 발송 (useSendThreadMessage)
      // 과 동일 패턴. 누락 시 contact 메일 히스토리 / 보낸편지함 / 대시보드 오픈 KPI / 타임라인이
      // 폴링 (또는 0건이면 영구) 으로만 갱신되어 stale.
      qc.invalidateQueries({ queryKey: ['contact_mail_history'] })
      qc.invalidateQueries({ queryKey: ['outbound-feed'] })
      qc.invalidateQueries({ queryKey: ['inbox-stats'] })
      qc.invalidateQueries({ queryKey: ['contact-send-history'] })
      if (stopReason || remaining > 0) {
        toast.error(stopToastMessage(stopReason ?? 'incomplete', campaignSent, remaining), {
          duration: 20000,
        })
        return
      }
      const modeSuffix = deliveryMode === 'link' ? ' (Drive 링크 전송)' : ''
      const seqSuffix = enrolled && enrolled > 0 ? ` · 후속 시퀀스 ${enrolled}명 등록` : ''
      if (failed === 0) {
        toast.success(`발송 완료: ${sent}/${total}${modeSuffix}${seqSuffix}`)
      } else {
        toast.warning(`발송 완료: 성공 ${sent}, 실패 ${failed}${modeSuffix}${seqSuffix}`)
      }
    },
    onError: (e: Error) => {
      console.error('[sendCampaign] failed:', e)
      toast.error(e.message || '발송 실패')
    },
  })
}
