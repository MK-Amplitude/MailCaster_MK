import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { sendGmail, encodeAttachmentsForReuse, type MailAttachment } from '@/lib/gmail'
import { getFreshGoogleToken, forceRefreshGoogleToken } from '@/lib/googleToken'
import { downloadFile, getFileMeta, shareAsPublicLink } from '@/lib/drive'
import { extractVariables, renderTemplate } from '@/lib/mailMerge'
import { GMAIL_ATTACHMENT_SAFE_THRESHOLD, formatBytes } from '@/lib/utils'
import { toast } from 'sonner'
import type { Recipient } from '@/types/campaign'
import type { Database } from '@/types/database.types'

type DriveAttachmentRow = Database['mailcaster']['Tables']['drive_attachments']['Row']

interface SendArgs {
  campaignId: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Google API 일시적 오류(429 rate limit, 5xx) exponential backoff 재시도.
 * 401(토큰 만료)/404(파일 없음)/403(권한 없음)/400(요청 오류) 은 재시도 대상 아님.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseMs?: number; maxMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, baseMs = 1000, maxMs = 10_000, label = 'api' } = opts
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (e) {
      const status = (e as { status?: number }).status
      const isRetryable =
        status === 429 || (typeof status === 'number' && status >= 500 && status < 600)
      attempt++
      if (!isRetryable || attempt >= maxAttempts) throw e
      const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1)) + Math.random() * 250
      console.warn(
        `[retry:${label}] status=${status} attempt=${attempt}/${maxAttempts - 1} wait=${Math.round(delay)}ms`
      )
      await sleep(delay)
    }
  }
}

/**
 * Google API 에러 → 한국어 사용자 메시지 매핑.
 * status 와 reason (error.errors[0].reason) 을 같이 본다.
 */
function mapGoogleError(e: unknown): string {
  const err = e as { status?: number; message?: string; reason?: string }
  const status = err.status
  const msg = err.message ?? String(e)
  const lower = msg.toLowerCase()

  if (status === 401) return '인증이 만료되었습니다. 다시 로그인해주세요.'
  if (status === 403) {
    if (lower.includes('storagequotaexceeded')) return 'Google Drive 용량이 부족합니다.'
    if (lower.includes('insufficientpermissions') || lower.includes('insufficient'))
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
  <p style="margin:0 0 8px 0;"><strong>📎 첨부 파일</strong> <span style="color:#6b7280;font-size:12px;">(Gmail 25MB 초과로 Google Drive 링크로 전달됩니다)</span></p>
  <ul style="padding-left:20px;margin:0;">${listItems}</ul>
</div>`.trim()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

export function injectTrackingPixel(html: string, pixelHtml: string): string {
  // </body> 태그가 있으면 그 앞에 삽입, 없으면 맨 뒤에.
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  }
  return html + pixelHtml
}

export function useSendCampaign() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ campaignId }: SendArgs) => {
      if (!user) throw new Error('로그인이 필요합니다.')

      // 1) 유효한 Google access_token 확보 (만료됐으면 refresh_token으로 자동 갱신)
      let accessToken = await getFreshGoogleToken(user.id)

      // 2) 캠페인 + 수신자 로드
      const { data: campaign, error: cErr } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .single()
      if (cErr) throw cErr

      const { data: recipients, error: rErr } = await supabase
        .from('recipients')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
      if (rErr) throw rErr

      if (!recipients || recipients.length === 0) {
        throw new Error('발송할 수신자가 없습니다.')
      }

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

      if (!finalBody.trim()) {
        throw new Error('발송할 본문이 비어있습니다. 템플릿 내용을 확인하세요.')
      }
      console.log('[sendCampaign] finalBody', { length: finalBody.length, source: 'body_html' })

      // 2-2) 첨부 파일 로드
      const { data: camAtt, error: caErr } = await supabase
        .from('campaign_attachments')
        .select('sort_order, drive_attachments(*)')
        .eq('campaign_id', campaignId)
        .order('sort_order', { ascending: true })
      if (caErr) throw caErr
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allAttachmentRows: DriveAttachmentRow[] = (camAtt ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.drive_attachments as DriveAttachmentRow)
        .filter(Boolean)

      const drive = makeDriveCaller(user.id)

      // 2-3) Preflight: 첨부 존재 확인 + 총 크기 기반 delivery_mode 결정
      //      S4: 개별 404 는 skip 하고 나머지로 계속 진행. 모두 삭제됐으면 abort.
      //      S8: Blob 으로 보관 — JS heap 사용 최소화 (Uint8Array 중간 복사본 제거).
      let deliveryMode: 'attachment' | 'link' = 'attachment'
      const downloadedBlobs = new Map<string, Blob>() // attachment_id → Blob
      const linkRefs: Array<{ filename: string; link: string; size: number | null }> = []
      let attachmentRows: DriveAttachmentRow[] = allAttachmentRows

      if (attachmentRows.length > 0) {
        // 메타 재확인 — Drive 에서 삭제된 파일 감지, 개별 404 는 skip
        const skipped: string[] = []
        const alive: DriveAttachmentRow[] = []
        for (const a of attachmentRows) {
          try {
            await drive.call((tok) => getFileMeta(tok, a.drive_file_id))
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

        const totalSize = attachmentRows.reduce((s, a) => s + (a.file_size ?? 0), 0)
        deliveryMode = totalSize > GMAIL_ATTACHMENT_SAFE_THRESHOLD ? 'link' : 'attachment'
        console.log('[sendCampaign] attachments', {
          count: attachmentRows.length,
          totalBytes: totalSize,
          deliveryMode,
        })

        if (deliveryMode === 'attachment') {
          // 모든 파일 다운로드 (Blob 으로 캐시 — JS heap 사용 최소화)
          for (const a of attachmentRows) {
            try {
              const blob = await drive.call((tok) => downloadFile(tok, a.drive_file_id))
              downloadedBlobs.set(a.id, blob)
            } catch (e) {
              throw new Error(mapGoogleError(e))
            }
          }
        } else {
          // S2: 이미 public 공유된 파일은 cached web_view_link 재사용 — API 호출 생략
          for (const a of attachmentRows) {
            if (a.is_public_shared && a.web_view_link) {
              linkRefs.push({ filename: a.file_name, link: a.web_view_link, size: a.file_size })
              continue
            }
            try {
              const link = await drive.call((tok) => shareAsPublicLink(tok, a.drive_file_id))
              linkRefs.push({ filename: a.file_name, link, size: a.file_size })
              await supabase
                .from('drive_attachments')
                .update({ is_public_shared: true, web_view_link: link })
                .eq('id', a.id)
            } catch (e) {
              throw new Error(mapGoogleError(e))
            }
          }
        }

        // drive token refresh 동안 accessToken 도 동일하게 최신화
        const cur = drive.current()
        if (cur) accessToken = cur
      }

      // 링크 모드면 본문에 섹션 append
      const linkSection = deliveryMode === 'link' ? buildLinkSection(linkRefs) : ''

      // 3) 캠페인 상태 sending 으로 전환
      //    W8) campaign.status 는 DbCampaignStatus union 이므로 그대로 사용.
      const previousStatus = campaign.status
      await supabase.from('campaigns').update({ status: 'sending' }).eq('id', campaignId)
      qc.invalidateQueries({ queryKey: ['campaigns'] })

      const fromEmail = user.email ?? ''
      const fromName = user.user_metadata?.full_name ?? user.user_metadata?.name ?? ''
      const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail

      // 캠페인 레벨 CC / BCC (모든 메일에 동일하게 포함)
      const campaignCc: string[] = Array.isArray(campaign.cc) ? (campaign.cc as string[]) : []
      const campaignBcc: string[] = Array.isArray(campaign.bcc) ? (campaign.bcc as string[]) : []
      const sendMode: 'individual' | 'bulk' =
        (campaign.send_mode as 'individual' | 'bulk' | null) === 'bulk' ? 'bulk' : 'individual'

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
          deliveryMode === 'attachment'
            ? await encodeAttachmentsForReuse(
                attachmentRows.map((a) => {
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
        await supabase
          .from('campaigns')
          .update({ status: previousStatus })
          .eq('id', campaignId)
        qc.invalidateQueries({ queryKey: ['campaigns'] })
        throw new Error(
          `첨부 파일 인코딩 실패: ${encErr instanceof Error ? encErr.message : String(encErr)}`
        )
      }
      if (deliveryMode === 'attachment') downloadedBlobs.clear()

      // 처음 성공한 순간 delivery_mode DB 에 bulk 기록 (S1 + N1)
      let deliveryModePersisted = false
      const persistDeliveryMode = async () => {
        if (deliveryModePersisted || attachmentRows.length === 0) return
        const ids = attachmentRows.map((a) => a.id)
        const { error: dmErr } = await supabase
          .from('campaign_attachments')
          .update({ delivery_mode: deliveryMode })
          .eq('campaign_id', campaignId)
          .in('attachment_id', ids)
        if (dmErr) {
          console.warn('[sendCampaign] delivery_mode bulk update failed:', dmErr)
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
        const rawSubject = campaign.subject ?? ''
        // bulk 에서는 수신자별 variables 치환이 불가능하므로 모든 {{...}} 변수는 차단 대상.
        // (개별 모드에서만 buildVariables/renderTemplate 이 돌아간다)
        const subjectVars = extractVariables(rawSubject)
        const bodyVars = extractVariables(finalBody)
        const allVars = Array.from(new Set([...subjectVars, ...bodyVars]))
        if (allVars.length > 0) {
          // 상태를 원복 후 에러 — 이미 'sending' 으로 바뀌어 있으므로 복구해야 함
          await supabase
            .from('campaigns')
            .update({ status: previousStatus })
            .eq('id', campaignId)
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
          await supabase
            .from('campaigns')
            .update({ status: previousStatus })
            .eq('id', campaignId)
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          throw new Error(
            `일괄 발송 수신자 합계가 ${totalAddresses}명으로 Gmail 상한(500)을 초과합니다. 개별 발송 모드를 사용하거나 수신자를 줄여주세요.`
          )
        }

        // 링크 모드면 본문에 링크 섹션 append (개별 모드와 동일)
        const html = linkSection ? `${finalBody}${linkSection}` : finalBody
        const bulkTo = toList.join(', ')

        let refreshedForBulk = false
        try {
          const result = await retryWithBackoff(
            async () => {
              try {
                return await sendGmail({
                  accessToken,
                  from,
                  to: bulkTo,       // 수신자 전원 노출 — 서로의 이메일이 To 에 보임
                  subject: rawSubject,
                  html,
                  attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
                  cc: campaignCc.length > 0 ? campaignCc : undefined,
                  bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
                })
              } catch (sendErr) {
                const status = (sendErr as { status?: number }).status
                if (status === 401 && !refreshedForBulk) {
                  refreshedForBulk = true
                  console.log('[sendCampaign:bulk] 401 detected, refreshing token')
                  accessToken = await forceRefreshGoogleToken()
                  return await sendGmail({
                    accessToken,
                    from,
                    to: bulkTo,
                    subject: rawSubject,
                    html,
                    attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
                    cc: campaignCc.length > 0 ? campaignCc : undefined,
                    bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
                  })
                }
                throw sendErr
              }
            },
            { label: 'gmail:bulk' }
          )

          // 전원 sent 로 일괄 업데이트 — 공통 gmail_message_id 기록
          const nowIso = new Date().toISOString()
          const { error: bulkUpdateErr } = await supabase
            .from('recipients')
            .update({
              status: 'sent',
              sent_at: nowIso,
              gmail_message_id: result.id,
              gmail_thread_id: result.threadId,
              error_message: null,
            })
            .eq('campaign_id', campaignId)
            .eq('status', 'pending')
          if (bulkUpdateErr) {
            console.warn('[sendCampaign:bulk] recipients bulk update failed:', bulkUpdateErr)
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
                  delivery_mode: deliveryMode,
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

          await supabase
            .from('campaigns')
            .update({ status: 'sent', sent_count: sent, failed_count: 0 })
            .eq('id', campaignId)

          qc.invalidateQueries({ queryKey: ['campaigns'] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          qc.invalidateQueries({ queryKey: ['attachment_stats'] })

          return { sent, failed: 0, total: recipients.length, deliveryMode }
        } catch (e) {
          // 실패 시 전원 failed 로 일괄 기록 + 캠페인 'failed' 로 전환
          const msg = e instanceof Error ? e.message : String(e)
          const friendly = mapGoogleError(e)
          console.error('[sendCampaign:bulk] failed:', msg)
          await supabase
            .from('recipients')
            .update({ status: 'failed', error_message: friendly })
            .eq('campaign_id', campaignId)
            .eq('status', 'pending')
          await supabase
            .from('campaigns')
            .update({
              status: 'failed',
              sent_count: 0,
              failed_count: recipients.length,
            })
            .eq('id', campaignId)
          qc.invalidateQueries({ queryKey: ['campaigns'] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })
          throw new Error(friendly)
        }
      }

      // ============================================================
      // INDIVIDUAL 모드 (기본) — 수신자별 루프
      // ============================================================
      // C2 + C3: try/catch/finally — abort 시 campaign 상태 rollback + stuck recipient 정리
      try {
        for (let i = 0; i < recipients.length; i++) {
          const r = recipients[i] as Recipient

          await supabase.from('recipients').update({ status: 'sending' }).eq('id', r.id)
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })

          try {
            const vars = buildVariables(r)
            const subject = renderTemplate(campaign.subject ?? '', vars)
            const renderedBody = renderTemplate(finalBody, vars)
            const htmlWithLinks = linkSection ? `${renderedBody}${linkSection}` : renderedBody
            // Phase 6 (C) — 오픈 추적 픽셀 주입 (캠페인 설정이 enable 이고 수신자 id 가 있을 때)
            const html = campaign.enable_open_tracking
              ? injectTrackingPixel(htmlWithLinks, buildTrackingPixel(r.id, campaignId))
              : htmlWithLinks
            console.log('[sendCampaign] preparing', {
              to: r.email,
              subjectLen: subject.length,
              htmlLen: html.length,
              attachmentCount: mailAttachments.length,
              mode: deliveryMode,
              tracking: !!campaign.enable_open_tracking,
            })

            // C1: 401 → 토큰 1회 refresh (refreshed flag 로 다중 refresh 방지),
            //     429/5xx → exponential backoff 재시도
            let refreshedForThisRecipient = false
            const result = await retryWithBackoff(
              async () => {
                try {
                  return await sendGmail({
                    accessToken,
                    from,
                    to: r.email,
                    toName: r.name,
                    subject,
                    html,
                    attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
                    cc: campaignCc.length > 0 ? campaignCc : undefined,
                    bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
                  })
                } catch (sendErr) {
                  const status = (sendErr as { status?: number }).status
                  if (status === 401 && !refreshedForThisRecipient) {
                    refreshedForThisRecipient = true
                    console.log('[sendCampaign] 401 detected, refreshing token')
                    accessToken = await forceRefreshGoogleToken()
                    return await sendGmail({
                      accessToken,
                      from,
                      to: r.email,
                      toName: r.name,
                      subject,
                      html,
                      attachments: mailAttachments.length > 0 ? mailAttachments : undefined,
                      cc: campaignCc.length > 0 ? campaignCc : undefined,
                      bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
                    })
                  }
                  throw sendErr
                }
              },
              { label: 'gmail' }
            )

            await supabase
              .from('recipients')
              .update({
                status: 'sent',
                sent_at: new Date().toISOString(),
                gmail_message_id: result.id,
                gmail_thread_id: result.threadId,
                error_message: null,
              })
              .eq('id', r.id)

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
                delivery_mode: deliveryMode,
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
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const friendly = mapGoogleError(e)
            console.error('[sendCampaign] recipient failed:', r.email, msg)
            await supabase
              .from('recipients')
              .update({
                status: 'failed',
                error_message: friendly,
              })
              .eq('id', r.id)
            failed++
          }

          await supabase
            .from('campaigns')
            .update({ sent_count: sent, failed_count: failed })
            .eq('id', campaignId)
          qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
          qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })

          if (i < recipients.length - 1 && delayMs > 0) {
            await sleep(delayMs)
          }
        }

        // 4) 최종 상태 처리
        const finalStatus = failed === recipients.length ? 'failed' : 'sent'
        await supabase
          .from('campaigns')
          .update({ status: finalStatus, sent_count: sent, failed_count: failed })
          .eq('id', campaignId)

        qc.invalidateQueries({ queryKey: ['attachment_stats'] })

        return { sent, failed, total: recipients.length, deliveryMode }
      } catch (abortErr) {
        // C2: 루프 외부에서 발생한 abort — campaign 상태 복원
        //     일부 보내졌으면 'failed' (부분 성공), 하나도 못 보냈으면 previousStatus 로 복귀
        console.error('[sendCampaign] aborted mid-send:', abortErr)
        const rollbackStatus = sent > 0 ? 'failed' : previousStatus
        // N2: 루프가 한 번도 돌지 않은 채 abort 된 경우 sent_count/failed_count 를 덮어쓰면
        //     이전 발송 이력(재발송 시 previousStatus='failed' 캠페인의 누적 카운트)이 0 으로
        //     소실된다. 최소 1건이라도 처리됐을 때만 카운트를 갱신.
        const rollbackUpdate: Database['mailcaster']['Tables']['campaigns']['Update'] = {
          status: rollbackStatus,
        }
        if (sent + failed > 0) {
          rollbackUpdate.sent_count = sent
          rollbackUpdate.failed_count = failed
        }
        await supabase
          .from('campaigns')
          .update(rollbackUpdate)
          .eq('id', campaignId)

        // C3: 'sending' 상태로 남은 수신자들을 'pending' 으로 복구
        const { error: cleanupErr } = await supabase
          .from('recipients')
          .update({
            status: 'pending',
            error_message: '발송이 중단되었습니다.',
          })
          .eq('campaign_id', campaignId)
          .eq('status', 'sending')
        if (cleanupErr) {
          console.error('[sendCampaign] cleanup failed:', cleanupErr)
        }

        qc.invalidateQueries({ queryKey: ['campaigns'] })
        qc.invalidateQueries({ queryKey: ['campaigns', 'recipients', campaignId] })
        qc.invalidateQueries({ queryKey: ['campaigns', 'detail', campaignId] })

        throw abortErr
      }
    },
    onSuccess: ({ sent, failed, total, deliveryMode }) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      const modeSuffix = deliveryMode === 'link' ? ' (Drive 링크 전송)' : ''
      if (failed === 0) {
        toast.success(`발송 완료: ${sent}/${total}${modeSuffix}`)
      } else {
        toast.warning(`발송 완료: 성공 ${sent}, 실패 ${failed}${modeSuffix}`)
      }
    },
    onError: (e: Error) => {
      console.error('[sendCampaign] failed:', e)
      toast.error(e.message || '발송 실패')
    },
  })
}
