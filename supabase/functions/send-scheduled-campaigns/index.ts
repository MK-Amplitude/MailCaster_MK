// Supabase Edge Function: send-scheduled-campaigns
// pg_cron 이 매 분마다 호출. status='scheduled' AND scheduled_at<=now() 인 캠페인을
// 자동으로 발송한다.
//
// ------------------------------------------------------------
// 지원 범위 (v2 — Phase 5)
// ------------------------------------------------------------
//   개별 발송 (send_mode='individual') — 수신자별 루프, 개인화 변수 치환
//   일괄 발송 (send_mode='bulk')       — 1회 Gmail 호출, 수신자 전원 To 에 노출
//   Cc / Bcc — 캠페인 레벨 캠페인.cc, 캠페인.bcc 를 모든 메일에 동일 적용
//   본문 — campaign.body_html 를 진실의 원천(WYSIWYG). 비어있을 때만 blocks+서명에서 재조합
//   ★ 첨부 파일 (v2) — Drive 에서 직접 다운로드/공유 후 MIME 에 포함
//     - 총합 크기가 EDGE_ATTACHMENT_SAFE_THRESHOLD 이하면 multipart/mixed 로 첨부
//     - 초과하거나 개별 파일이 Gmail 제한에 근접하면 자동 link 모드로 전환
//       → 본문에 Drive 공유 링크 섹션을 append
//
// ------------------------------------------------------------
// 보안
// ------------------------------------------------------------
//   Authorization: Bearer <CRON_SECRET>  (pg_cron 주입)
//   profiles.google_refresh_token — service_role 로만 접근 가능
//
// ------------------------------------------------------------
// 락킹
// ------------------------------------------------------------
//   같은 분에 cron 이 중복 호출되더라도 campaign.status='sending' 으로 먼저
//   바꾼 쪽이 이긴다 (update 결과가 1건이면 '획득'). 나머지는 skip.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

// 한 번 실행 시 처리할 최대 캠페인 수 — 55초 타임아웃 대비 보수적으로
const MAX_CAMPAIGNS_PER_RUN = 10

// ------------------------------------------------------------
// Phase 6 (A) — 한 run 당 쓸 수 있는 최대 시간 (ms).
// pg_cron 이 매 분 호출하고 timeout_milliseconds=55000 으로 끊는다.
// 50초를 예산으로 두고, 이걸 넘어서면 체크포인트 저장 후 즉시 종료 →
// 다음 tick 에서 이어서 처리. (send_delay_seconds × recipient 가 크면
// 예전에는 도중에 끊겨 캠페인이 'sending' 으로 stuck 됐음.)
// ------------------------------------------------------------
const RUN_BUDGET_MS = 50_000

// Edge 환경에서 안전한 총합 첨부 크기 상한 (base64 인코딩 오버헤드 1.33× 고려).
// Gmail 한계 25MB 보다 보수적. 초과 시 link 모드로 자동 전환.
//   - 클라이언트(useSendCampaign.ts)는 GMAIL_ATTACHMENT_SAFE_THRESHOLD=20MB 사용
//   - 엣지는 Deno heap 고려해 15MB 로 더 보수적
const EDGE_ATTACHMENT_SAFE_THRESHOLD = 15 * 1024 * 1024

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Recipient {
  id: string
  email: string
  name: string | null
  variables: Record<string, unknown> | null
  subject_override: string | null
  body_html_override: string | null
}

interface Campaign {
  id: string
  user_id: string
  name: string
  subject: string | null
  body_html: string | null
  signature_id: string | null
  send_delay_seconds: number | null
  cc: string[] | null
  bcc: string[] | null
  send_mode: string | null
  scheduled_at: string | null
  status: string
  // Phase 6 (A) — 체크포인트
  sending_started_at: string | null
  last_processed_recipient_id: string | null
  // Phase 6 (C) — 오픈 추적 on/off
  enable_open_tracking: boolean | null
  // 069 — 발송 완료 후 수신자를 등록할 후속 시퀀스
  followup_sequence_id: string | null
}

interface DriveAttachmentRow {
  id: string
  drive_file_id: string
  file_name: string
  file_size: number | null
  mime_type: string | null
  web_view_link: string | null
  is_public_shared: boolean | null
}

interface PreparedAttachment {
  id: string
  filename: string
  mimeType: string
  size: number | null
  // attachment 모드에서만 채움
  base64?: string
  // link 모드에서만 채움
  link?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!CRON_SECRET) return json({ error: 'CRON_SECRET not configured' }, 500)
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${CRON_SECRET}`) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const runStartedAt = Date.now()

  try {
    // ------------------------------------------------------------
    // 1) 처리 대상 캠페인 조회
    //    Phase 6 (A) — status='sending' 이며 체크포인트(sending_started_at) 가
    //    기록된 캠페인도 재개 대상으로 함께 집는다. 'scheduled' 는 종전처럼 도래한 것만.
    //
    // 'sending' 인데 체크포인트가 없는 건 "방금 락 획득한 동시 실행" 이거나
    // 클라이언트 즉시 발송 중 케이스이므로 cron 이 건드리지 않는다.
    // ------------------------------------------------------------
    const nowIso = new Date().toISOString()
    const { data: due, error: dErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .select(
        'id, user_id, name, subject, body_html, signature_id, send_delay_seconds, cc, bcc, send_mode, scheduled_at, status, sending_started_at, last_processed_recipient_id, enable_open_tracking, followup_sequence_id'
      )
      .or(
        `and(status.eq.scheduled,scheduled_at.lte.${nowIso}),and(status.eq.sending,sending_started_at.not.is.null)`
      )
      .order('scheduled_at', { ascending: true })
      .limit(MAX_CAMPAIGNS_PER_RUN)

    if (dErr) throw dErr
    if (!due || due.length === 0) {
      return json({ processed: 0, sent: 0, failed: 0, message: 'no due campaigns' })
    }

    let totalSent = 0
    let totalFailed = 0
    const perCampaign: Array<{
      id: string
      sent: number
      failed: number
      paused?: boolean
      error?: string
    }> = []

    for (const c of due as Campaign[]) {
      // 런 예산이 소진됐으면 이 tick 에서는 추가 캠페인에 손대지 않는다.
      // 아직 처리하지 않은 캠페인은 status 그대로 두므로 다음 cron 에서 자연스럽게 집힌다.
      if (Date.now() - runStartedAt >= RUN_BUDGET_MS) {
        console.log(
          `[send-scheduled] run budget exhausted — deferring ${due.length - perCampaign.length} campaigns to next tick`
        )
        break
      }
      try {
        const r = await processCampaign(supabase, c, runStartedAt)
        totalSent += r.sent
        totalFailed += r.failed
        perCampaign.push({ id: c.id, ...r })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[send-scheduled] campaign ${c.id} fatal:`, msg)
        perCampaign.push({ id: c.id, sent: 0, failed: 0, error: msg })
        // W7) 캠페인 상태를 failed 로 전환하고 체크포인트를 리셋한다.
        //     체크포인트가 남아 있으면 관리자/사용자가 수동으로 "재발송" 할 때
        //     재개 경로 (status='sending' + sending_started_at IS NOT NULL) 에
        //     오진입할 수 있어 혼란이 생김.
        //     failed 로 내려가는 즉시 sending_started_at / last_processed_recipient_id 를
        //     NULL 로 되돌려 깨끗한 재발송을 보장.
        await supabase
          .schema('mailcaster')
          .from('campaigns')
          .update({
            status: 'failed',
            sending_started_at: null,
            last_processed_recipient_id: null,
          })
          .eq('id', c.id)
      }
    }

    return json({
      processed: perCampaign.length,
      sent: totalSent,
      failed: totalFailed,
      campaigns: perCampaign,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[send-scheduled] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

// ------------------------------------------------------------
// 개별 캠페인 처리
// ------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function processCampaign(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  c: Campaign,
  runStartedAt: number,
): Promise<{ sent: number; failed: number; paused?: boolean }> {
  // 1) 락 획득
  //    Phase 6 (A) — 두 가지 진입 경로 지원:
  //      a) 신규 발송: status='scheduled' → 'sending' + sending_started_at=NOW()
  //      b) 재개 발송: status='sending' 이며 sending_started_at 이 이미 있는 경우
  //         (다른 cron 이 동시에 집는 걸 막기 위해 sending_started_at 값을 조건에 걸어 CAS)
  //
  //    어느 쪽이든 UPDATE 결과가 1건일 때만 "이 run 이 소유" 한다.
  if (c.status === 'scheduled') {
    const { data: locked, error: lockErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ status: 'sending', sending_started_at: new Date().toISOString() })
      .eq('id', c.id)
      .eq('status', 'scheduled')
      .select('id, sending_started_at')
    if (lockErr) throw lockErr
    if (!locked || locked.length === 0) {
      console.log(`[send-scheduled] campaign ${c.id} already picked up — skip`)
      return { sent: 0, failed: 0 }
    }
  } else if (c.status === 'sending' && c.sending_started_at) {
    // 재개: sending_started_at 의 현재 값을 "CAS token" 으로 사용해 경쟁 회피.
    // touch 로만 변화 유도해야 하므로 같은 값으로 다시 쓴다. (Supabase 는 변경 없으면 빈 결과 → 토큰 일치 시 성공 표현으로 updated_at 트리거/컬럼을 쓰는 게 더 안전하지만
    // 현재 campaigns 에는 updated_at 이 없으므로 이 방식으로 충분.)
    const { data: touched, error: lockErr } = await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ sending_started_at: c.sending_started_at })
      .eq('id', c.id)
      .eq('status', 'sending')
      .eq('sending_started_at', c.sending_started_at)
      .select('id')
    if (lockErr) throw lockErr
    if (!touched || touched.length === 0) {
      console.log(`[send-scheduled] campaign ${c.id} resume raced — skip`)
      return { sent: 0, failed: 0 }
    }
    console.log(`[send-scheduled] campaign ${c.id} resuming from checkpoint`)
  } else {
    // 예상 못한 상태 (status=sending 인데 sending_started_at=NULL) — 안전하게 skip
    console.log(`[send-scheduled] campaign ${c.id} unexpected state — skip`)
    return { sent: 0, failed: 0 }
  }

  // 2) 수신자 로드 — pending + 고립된 'sending' (orphan recovery).
  //    개인화 발송(personalized-send) 으로 미리 작성된 per-recipient subject/body
  //    오버라이드도 함께 가져온다 — useSendCampaign.ts 클라이언트 경로와 동작 일치.
  //
  //    Orphan 'sending' 의 정의: status='sending' AND gmail_message_id IS NULL.
  //    이전 tick 에서 발송 직전 pre-mark 후 함수 워커가 timeout/크래시로 종료되면
  //    상태가 영원히 'sending' 으로 고립됨. 캠페인 레벨 CAS 락이 있으므로 같은
  //    캠페인에 동시 처리는 없고, gmail_message_id 가 NULL 이면 실제 발송도 안 된 상태라
  //    안전하게 재시도 가능.
  const { data: rawRecipients, error: rErr } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select(
      'id, email, name, variables, subject_override, body_html_override, contact:contacts(is_bounced, is_unsubscribed)',
    )
    .eq('campaign_id', c.id)
    .in('status', ['pending', 'sending'])
    .is('gmail_message_id', null)
    .order('created_at', { ascending: true })
  if (rErr) throw rErr

  // 안전망 — 캠페인 생성 시점에 정상이었던 contact 가 그 후 bounce/unsubscribe 됐다면
  // 발송 직전 차단. CampaignWizardPage 가 wizard 시점에 필터하지만, 시간이 지나
  // check-replies 가 bounce 를 감지한 경우 등에 대비.
  type RecipientWithJoin = {
    id: string
    email: string
    name: string | null
    variables: Record<string, unknown> | null
    subject_override: string | null
    body_html_override: string | null
    contact?:
      | { is_bounced: boolean | null; is_unsubscribed: boolean | null }
      | { is_bounced: boolean | null; is_unsubscribed: boolean | null }[]
      | null
  }
  const skipped: Array<{ id: string; reason: string }> = []
  const recipients: Recipient[] = []
  for (const raw of (rawRecipients ?? []) as RecipientWithJoin[]) {
    const ct = Array.isArray(raw.contact) ? raw.contact[0] : raw.contact
    if (ct?.is_bounced) {
      skipped.push({ id: raw.id, reason: '연락처가 반송 상태로 표시되어 발송 차단' })
      continue
    }
    if (ct?.is_unsubscribed) {
      skipped.push({ id: raw.id, reason: '연락처가 수신거부 상태로 발송 차단' })
      continue
    }
    recipients.push({
      id: raw.id,
      email: raw.email,
      name: raw.name,
      variables: raw.variables,
      subject_override: raw.subject_override,
      body_html_override: raw.body_html_override,
    })
  }
  // 차단된 행은 즉시 failed 처리 — 카운터에 잡히도록.
  for (const s of skipped) {
    await supabase
      .schema('mailcaster')
      .from('recipients')
      .update({ status: 'failed', error_message: s.reason })
      .eq('id', s.id)
  }

  if (recipients.length === 0) {
    await supabase
      .schema('mailcaster')
      .from('campaigns')
      .update({ status: 'sent' })  // 보낼 게 없어도 "완료" 상태로
      .eq('id', c.id)
    return { sent: 0, failed: 0 }
  }

  // 3) 본문 확정 — campaign.body_html 을 진실의 원천으로 사용 (useSendCampaign.ts 와 동일)
  let finalBody = c.body_html ?? ''
  if (!finalBody.trim()) {
    console.warn(`[send-scheduled] campaign ${c.id} body_html empty — fallback recompose`)
    const { data: blocks, error: bErr } = await supabase
      .schema('mailcaster')
      .from('campaign_blocks')
      .select('template_id, position')
      .eq('campaign_id', c.id)
      .order('position', { ascending: true })
    if (bErr) throw bErr
    if (blocks && blocks.length > 0) {
      const ids = blocks.map((b: { template_id: string }) => b.template_id)
      const { data: tpls, error: tErr } = await supabase
        .schema('mailcaster')
        .from('templates')
        .select('id, body_html')
        .in('id', ids)
      if (tErr) throw tErr
      const tMap = new Map<string, string>(
        (tpls ?? []).map((t: { id: string; body_html: string | null }) => [
          t.id,
          t.body_html ?? '',
        ])
      )
      const composed = blocks
        .map((b: { template_id: string }) => tMap.get(b.template_id) ?? '')
        .filter(Boolean)
        .join('<br/><br/>')
      if (c.signature_id) {
        const { data: sig } = await supabase
          .schema('mailcaster')
          .from('signatures')
          .select('html')
          .eq('id', c.signature_id)
          .single()
        finalBody = sig?.html ? `${composed}<br/><br/>${sig.html}` : composed
      } else {
        finalBody = composed
      }
    }
  }
  if (!finalBody.trim()) {
    throw new Error('발송할 본문이 비어있습니다')
  }

  // 3.4) 시그니처 fallback — body_html 이 채워져 있어도 시그니처가 빠진 경우 (위저드에서
  //      본문 인라인 편집으로 시그니처를 지운 캠페인) 즉시 발송 (useSendCampaign) 과 동일하게 append.
  //      이게 없으면 같은 캠페인이 발송 경로 (즉시 vs 예약) 에 따라 시그니처 유무가 달라짐.
  //      bodyAlreadyContainsSignature 와 동일한 plain-text fragment 매칭 사용.
  if (c.signature_id) {
    const { data: sig } = await supabase
      .schema('mailcaster')
      .from('signatures')
      .select('html')
      .eq('id', c.signature_id)
      .single()
    const sigHtml = sig?.html ?? ''
    if (sigHtml && !bodyContainsSignature(finalBody, sigHtml)) {
      finalBody = `${finalBody}<br/><br/>${sigHtml}`
    }
  }

  // 3.5) Inline 이미지 추출 — 본문의 <img src="..."> 를 fetch 해서 base64 로 메일에
  //      박는다. 결과: html 의 src 가 cid:xxx 로 치환됨 + inlineImages 배열.
  //      메일 자체가 자기완결적 — Storage URL 이 사라져도 발송된 메일은 영구 표시.
  //      외부 이미지 차단도 우회.
  const { html: bodyWithCids, images: inlineImages } = await extractAndInlineImages(
    finalBody,
  )
  finalBody = bodyWithCids
  if (inlineImages.length > 0) {
    console.log(`[send-scheduled] campaign ${c.id} inline images: ${inlineImages.length}`)
  }

  // 4) 사용자 프로필 + refresh_token 로 access_token 갱신
  const { data: profile, error: pErr } = await supabase
    .schema('mailcaster')
    .from('profiles')
    .select('email, display_name, default_sender_name, google_refresh_token')
    .eq('id', c.user_id)
    .single()
  if (pErr) throw pErr
  if (!profile?.google_refresh_token) {
    throw new Error('사용자의 Google refresh_token 이 없습니다. 재로그인 필요.')
  }
  // W5) let 으로 보관 — 발송 도중 401 을 받으면 refresh 후 덮어씀.
  //     토큰은 일반적으로 55분 여유가 있지만 운영 중 Google 측 revoke/회전 이벤트가 간헐 발생.
  let accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
  const refreshTokenCached = profile.google_refresh_token as string

  // sendGmail 호출 래퍼 — 401 발생 시 토큰을 갱신해 1회 재시도.
  // 그 외 오류는 그대로 throw (호출자 측 per-recipient 에러 핸들러가 처리).
  async function sendGmailWithAutoRefresh(
    input: Omit<GmailSendInput, 'accessToken'>,
  ): Promise<{ id: string; threadId: string }> {
    try {
      return await sendGmail({ ...input, accessToken })
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status !== 401) throw e
      console.log(`[send-scheduled] 401 → refreshing token for campaign ${c.id}`)
      accessToken = await refreshGoogleToken(refreshTokenCached)
      return await sendGmail({ ...input, accessToken })
    }
  }

  // 5) DB 업데이트 — 토큰 캐시
  await supabase
    .schema('mailcaster')
    .from('profiles')
    .update({
      google_access_token: accessToken,
      token_expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(), // 55분 안전마진
    })
    .eq('id', c.user_id)

  // 6) 첨부 파일 로드 + 모드 결정 + 다운로드/공유
  //    실패 시 전체 캠페인을 실패 처리. (useSendCampaign.ts 의 preflight 와 동일 정책)
  const { mode: deliveryMode, attachments: prepared, linkSection } =
    await prepareAttachments(supabase, accessToken, c.id, c.user_id)

  // 7) 첨부가 있으면 campaign_attachments 에 delivery_mode 기록 (S1: 결정된 모드 저장)
  if (prepared.length > 0) {
    const ids = prepared.map((a) => a.id)
    await supabase
      .schema('mailcaster')
      .from('campaign_attachments')
      .update({ delivery_mode: deliveryMode })
      .eq('campaign_id', c.id)
      .in('attachment_id', ids)
  }

  const fromEmail = (profile.email as string | null) ?? ''
  if (!fromEmail.trim()) {
    // From 이 빈 값이면 Gmail 이 malformed MIME 으로 거부하거나 정체불명의 발송이 됨.
    // 캠페인 자체를 fail 시키는 게 sane default — 운영자가 profile.email 을 채우게 유도.
    throw new Error('사용자 프로필의 이메일 주소가 비어 있습니다.')
  }
  const fromName =
    (profile.default_sender_name as string | null) ?? (profile.display_name as string | null) ?? ''
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  const campaignCc: string[] = Array.isArray(c.cc) ? c.cc : []
  const campaignBcc: string[] = Array.isArray(c.bcc) ? c.bcc : []
  const sendMode: 'individual' | 'bulk' = c.send_mode === 'bulk' ? 'bulk' : 'individual'

  // 링크 모드면 본문에 링크 섹션 append (개별/일괄 공통)
  const bodyWithLinks = linkSection ? `${finalBody}${linkSection}` : finalBody
  // 첨부(base64) 배열 — 없으면 undefined
  const mailAttachments: MailAttachment[] | undefined =
    deliveryMode === 'attachment' && prepared.length > 0
      ? prepared.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          base64: a.base64 ?? '',
        }))
      : undefined

  // ------------------------------------------------------------
  // BULK — 1회 호출
  // ------------------------------------------------------------
  if (sendMode === 'bulk') {
    // 개인화 오버라이드가 하나라도 있으면 일괄 발송 불가 — 개인별 본문이 손실됨.
    // 빈 문자열은 무시 (실질적으로 override 없음).
    const hasOverride = (recipients as Recipient[]).some(
      (r) => !!r.subject_override?.trim() || !!r.body_html_override?.trim(),
    )
    if (hasOverride) {
      const errMsg =
        '일괄 발송 모드인데 일부 수신자에 개인화 오버라이드가 있습니다. 개별 발송 모드로 전환하세요.'
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: errMsg })
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({ status: 'failed', failed_count: recipients.length })
        .eq('id', c.id)
      return { sent: 0, failed: recipients.length }
    }

    // 개인화 변수 사전 차단
    const vars = [...extractVariables(c.subject ?? ''), ...extractVariables(finalBody)]
    if (vars.length > 0) {
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          status: 'failed',
          error_message: `일괄 발송에는 개인화 변수를 사용할 수 없습니다: ${vars.map((v) => `{{${v}}}`).join(', ')}`,
        })
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({ status: 'failed', failed_count: recipients.length })
        .eq('id', c.id)
      return { sent: 0, failed: recipients.length }
    }

    // 빈 이메일은 일괄 발송에 포함하면 Gmail 이 전체 호출을 거부할 수 있음.
    // 개별 사전 차단 후 toList 구성.
    const validRecipients = (recipients as Recipient[]).filter((r) => r.email?.trim())
    const invalidRecipients = (recipients as Recipient[]).filter((r) => !r.email?.trim())
    if (invalidRecipients.length > 0) {
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: '이메일 주소가 비어 있습니다.' })
        .in('id', invalidRecipients.map((r) => r.id))
    }
    if (validRecipients.length === 0) {
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({ status: 'failed', failed_count: invalidRecipients.length })
        .eq('id', c.id)
      return { sent: 0, failed: invalidRecipients.length }
    }
    const toList = validRecipients.map((r) => r.email)
    if (toList.length + campaignCc.length + campaignBcc.length > 500) {
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          status: 'failed',
          error_message: `일괄 발송 수신자 합계가 500명을 초과합니다.`,
        })
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({ status: 'failed', failed_count: recipients.length })
        .eq('id', c.id)
      return { sent: 0, failed: recipients.length }
    }

    try {
      const result = await sendGmailWithAutoRefresh({
        from,
        to: toList.join(', '),
        subject: c.subject ?? '',
        html: bodyWithLinks,
        cc: campaignCc.length > 0 ? campaignCc : undefined,
        bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
        attachments: mailAttachments,
        inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
      })
      const sentAt = new Date().toISOString()
      // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — bulk 는 1통이므로 공통 rfc.
      const bulkRfc = c.followup_sequence_id
        ? await fetchMessageRfcId(accessToken, result.id)
        : null
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          status: 'sent',
          sent_at: sentAt,
          gmail_message_id: result.id,
          gmail_thread_id: result.threadId,
          rfc_message_id: bulkRfc,
          error_message: null,
        })
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({
          status: 'sent',
          sent_count: validRecipients.length,
          failed_count: invalidRecipients.length,
        })
        .eq('id', c.id)
      // 첨부 이력 기록 — 발송된 수신자만 (invalidRecipients 제외)
      await recordRecipientAttachments(
        supabase,
        c,
        validRecipients,
        prepared,
        deliveryMode,
      )
      // 후속 시퀀스 등록 (발송 완료 시)
      await enrollFollowupSequence(supabase, c)
      return { sent: validRecipients.length, failed: invalidRecipients.length }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: msg })
        .eq('campaign_id', c.id)
        .eq('status', 'pending')
      await supabase
        .schema('mailcaster')
        .from('campaigns')
        .update({
          status: 'failed',
          sent_count: 0,
          failed_count: recipients.length,
        })
        .eq('id', c.id)
      return { sent: 0, failed: recipients.length }
    }
  }

  // ------------------------------------------------------------
  // INDIVIDUAL — 수신자별 루프
  //
  // Phase 6 (A) — 시간 예산을 넘으면 체크포인트 저장 후 중단.
  //   - recipients 를 로드할 때 이미 status='pending' 만 가져오므로 재진입 안전.
  //   - 각 반복마다 "다음 발송을 시작할 시간" 이 RUN_BUDGET_MS 를 넘는지 확인.
  //     남은 시간이 delayMs + 안전마진(5초, Gmail 호출용) 보다 적으면 pause.
  //   - pause 시 status 는 'sending' 을 유지 (campaign row 는 다음 tick 에 cron 이 재개).
  //     sending_started_at 은 유지, last_processed_recipient_id 만 갱신.
  // ------------------------------------------------------------
  const GMAIL_CALL_BUDGET_MS = 5_000
  let sent = 0
  let failed = 0
  let paused = false
  const delayMs = Math.max(0, (c.send_delay_seconds ?? 3) * 1000)

  // W6) baseline — "재개 시점의 누적 sent/failed" 를 1회만 조회.
  //     이후 루프 안에서는 로컬 카운터(sent/failed) 를 더해 UPDATE — 매 루프 count 쿼리 2회 제거.
  //     신규 발송의 경우 baseline 은 0/0. 재개의 경우엔 이미 sent 된 것들의 누적값.
  const { count: baselineSentRaw } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'sent')
  const { count: baselineFailedRaw } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'failed')
  const baselineSent = baselineSentRaw ?? 0
  const baselineFailed = baselineFailedRaw ?? 0

  for (let i = 0; i < recipients.length; i++) {
    // 이 반복을 시작하기 전에 남은 예산 확인
    const elapsed = Date.now() - runStartedAt
    const remaining = RUN_BUDGET_MS - elapsed
    if (remaining < GMAIL_CALL_BUDGET_MS) {
      paused = true
      console.log(
        `[send-scheduled] campaign ${c.id} pausing at ${i}/${recipients.length} — remaining=${remaining}ms`
      )
      break
    }

    const r = recipients[i] as Recipient

    // 빈 이메일 사전 차단 — Gmail API 가 묵묵히 실패하거나 부분 성공으로 빠져 사용자가 인지 못 함.
    if (!r.email || !r.email.trim()) {
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: '이메일 주소가 비어 있습니다.' })
        .eq('id', r.id)
      failed++
      continue
    }

    await supabase
      .schema('mailcaster')
      .from('recipients')
      .update({ status: 'sending' })
      .eq('id', r.id)

    try {
      const vars = buildVariables(r)
      // 개인화 오버라이드 우선 — useSendCampaign.ts 와 동일 정책. (LLM 이 사람마다 직접
      // 작성한 문장이라 템플릿 변수 치환은 적용하지 않는다.)
      // 빈 문자열은 null 처럼 취급 — '' 가 들어 있으면 빈 제목/본문 발송 위험.
      const subjOverride = r.subject_override?.trim() ? r.subject_override : null
      const bodyOverride = r.body_html_override?.trim() ? r.body_html_override : null
      const subject = subjOverride ?? renderTemplate(c.subject ?? '', vars)
      const renderedHtml = bodyOverride
        ? (linkSection ? `${bodyOverride}${linkSection}` : bodyOverride)
        : renderTemplate(bodyWithLinks, vars)
      // Phase 6 (C) — 오픈 추적 픽셀 주입 (캠페인 설정 on 일 때만)
      const html = c.enable_open_tracking
        ? injectTrackingPixel(renderedHtml, buildTrackingPixel(r.id, c.id))
        : renderedHtml
      const result = await sendGmailWithAutoRefresh({
        from,
        to: r.email,
        toName: r.name,
        subject,
        html,
        cc: campaignCc.length > 0 ? campaignCc : undefined,
        bcc: campaignBcc.length > 0 ? campaignBcc : undefined,
        attachments: mailAttachments,
        inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
      })
      // 후속 시퀀스가 붙었으면 RFC Message-ID 조회 — followup In-Reply-To 용.
      const rfcMessageId = c.followup_sequence_id
        ? await fetchMessageRfcId(accessToken, result.id)
        : null
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          gmail_message_id: result.id,
          gmail_thread_id: result.threadId,
          rfc_message_id: rfcMessageId,
          error_message: null,
        })
        .eq('id', r.id)
      // 개별 수신자 첨부 이력 기록
      await recordRecipientAttachments(supabase, c, [r], prepared, deliveryMode)
      sent++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[send-scheduled] recipient ${r.email} failed:`, msg)
      await supabase
        .schema('mailcaster')
        .from('recipients')
        .update({ status: 'failed', error_message: msg })
        .eq('id', r.id)
      failed++
    }

    // 캠페인 카운터 + 체크포인트
    //   W6) baseline + 로컬 증분으로 갱신. count 쿼리 없이 update 한 번만 발생.
    //   300명 발송 시 기존 900 RTT → 300 RTT 로 감소.
    await advanceCheckpoint(
      supabase,
      c.id,
      r.id,
      baselineSent + sent,
      baselineFailed + failed,
    )

    if (i < recipients.length - 1 && delayMs > 0) {
      // delay 도중 예산 초과되면 쉬지 않고 깔끔히 탈출
      const before = Date.now()
      if (before - runStartedAt + delayMs > RUN_BUDGET_MS - GMAIL_CALL_BUDGET_MS) {
        paused = true
        console.log(
          `[send-scheduled] campaign ${c.id} pausing during delay window after ${i + 1}/${recipients.length}`
        )
        break
      }
      await sleep(delayMs)
    }
  }

  // ------------------------------------------------------------
  // 마무리 — paused 면 status='sending' 유지 (다음 cron 이 재개),
  //          완료면 sent/failed 결정.
  // ------------------------------------------------------------
  if (paused) {
    // sending_started_at 은 이미 찍혀있음. 체크포인트는 위 updateCampaignCounters 가 이미 업데이트했음.
    return { sent, failed, paused: true }
  }

  // 남은 미완료 (pending 또는 orphan sending) 이 0 이어야 "완료".
  // orphan 'sending' (gmail_message_id IS NULL) 은 발송 안 된 상태라 미완료로 간주 →
  // 다음 tick 에서 SELECT 재처리.
  const { count: remainingIncomplete } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .in('status', ['pending', 'sending'])
    .is('gmail_message_id', null)

  if ((remainingIncomplete ?? 0) > 0) {
    // 미처리 행이 남아 있으면 paused 처리 — 다음 cron 이 재개.
    return { sent, failed, paused: true }
  }

  // 최종 집계 재계산
  const { count: totalSentCount } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'sent')
  const { count: totalFailedCount } = await supabase
    .schema('mailcaster')
    .from('recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .eq('status', 'failed')

  const sentTotal = totalSentCount ?? 0
  const failedTotal = totalFailedCount ?? 0
  const finalStatus = sentTotal === 0 && failedTotal > 0 ? 'failed' : 'sent'
  await supabase
    .schema('mailcaster')
    .from('campaigns')
    .update({ status: finalStatus, sent_count: sentTotal, failed_count: failedTotal })
    .eq('id', c.id)

  // 후속 시퀀스 등록 (개별 발송 완료 시 — paused 가 아니라 실제 완료된 경우만 여기 도달)
  await enrollFollowupSequence(supabase, c)

  return { sent, failed }
}

// ------------------------------------------------------------
// Phase 6 (A/W6) 도우미 — 캠페인 카운터 + 체크포인트 갱신
//   호출자에서 baseline(= 시작 전 DB 누적) + 로컬 증분 을 합해 넘겨준다.
//   → count 쿼리 없이 UPDATE 한 번만 수행 (1 RTT).
//   최종 정확성은 processCampaign 의 "최종 집계 재계산" 블록이 COUNT 로 재확인.
// ------------------------------------------------------------
async function advanceCheckpoint(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  campaignId: string,
  lastRecipientId: string,
  sentCumulative: number,
  failedCumulative: number,
) {
  await supabase
    .schema('mailcaster')
    .from('campaigns')
    .update({
      sent_count: sentCumulative,
      failed_count: failedCumulative,
      last_processed_recipient_id: lastRecipientId,
    })
    .eq('id', campaignId)
}

// ------------------------------------------------------------
// 첨부 준비 — 총크기 기반 delivery_mode 결정 후 base64/링크 확보
// ------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function prepareAttachments(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  accessToken: string,
  campaignId: string,
  userId: string,
): Promise<{ mode: 'attachment' | 'link'; attachments: PreparedAttachment[]; linkSection: string }> {
  // 1) campaign_attachments + drive_attachments 조인
  const { data: rows, error } = await supabase
    .schema('mailcaster')
    .from('campaign_attachments')
    .select('attachment_id, sort_order, drive_attachments(*)')
    .eq('campaign_id', campaignId)
    .order('sort_order', { ascending: true })
  if (error) throw error
  if (!rows || rows.length === 0) {
    return { mode: 'attachment', attachments: [], linkSection: '' }
  }

  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driveRows: DriveAttachmentRow[] = (rows as any[])
    .map((r) => r.drive_attachments as DriveAttachmentRow)
    .filter(Boolean)

  if (driveRows.length === 0) {
    return { mode: 'attachment', attachments: [], linkSection: '' }
  }

  // 2) 파일 메타 재확인 — Drive 에서 삭제된 파일 skip
  const alive: DriveAttachmentRow[] = []
  for (const a of driveRows) {
    try {
      await driveGetMeta(accessToken, a.drive_file_id)
      alive.push(a)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 404) {
        console.warn(`[send-scheduled] attachment ${a.file_name} deleted from Drive — skip`)
        await supabase
          .schema('mailcaster')
          .from('drive_attachments')
          .update({ deleted_from_drive_at: new Date().toISOString() })
          .eq('id', a.id)
          .eq('user_id', userId)
      } else {
        throw e
      }
    }
  }
  if (alive.length === 0) {
    throw new Error('첨부 파일이 모두 Drive 에서 삭제되었습니다. 발송을 중단합니다.')
  }

  // 3) 총 크기 기반 모드 결정
  const totalSize = alive.reduce((s, a) => s + (a.file_size ?? 0), 0)
  const mode: 'attachment' | 'link' =
    totalSize > EDGE_ATTACHMENT_SAFE_THRESHOLD ? 'link' : 'attachment'
  console.log('[send-scheduled] attachments', {
    count: alive.length,
    totalBytes: totalSize,
    mode,
  })

  const prepared: PreparedAttachment[] = []

  if (mode === 'attachment') {
    // 다운로드 후 base64 인코딩 (수신자 수와 무관하게 1회만)
    for (const a of alive) {
      const blob = await driveDownload(accessToken, a.drive_file_id)
      const base64 = await blobToBase64(blob)
      prepared.push({
        id: a.id,
        filename: a.file_name,
        mimeType: a.mime_type ?? 'application/octet-stream',
        size: a.file_size,
        base64,
      })
    }
    return { mode, attachments: prepared, linkSection: '' }
  }

  // link 모드 — 이미 공개 공유된 건 캐시된 link 재사용
  for (const a of alive) {
    let link: string
    if (a.is_public_shared && a.web_view_link) {
      link = a.web_view_link
    } else {
      link = await driveShareAsPublicLink(accessToken, a.drive_file_id)
      await supabase
        .schema('mailcaster')
        .from('drive_attachments')
        .update({ is_public_shared: true, web_view_link: link })
        .eq('id', a.id)
        .eq('user_id', userId)
    }
    prepared.push({
      id: a.id,
      filename: a.file_name,
      mimeType: a.mime_type ?? 'application/octet-stream',
      size: a.file_size,
      link,
    })
  }
  return { mode, attachments: prepared, linkSection: buildLinkSection(prepared) }
}

// ------------------------------------------------------------
// 수신자 × 첨부 매핑 이력 기록 (recipient_attachments)
// ------------------------------------------------------------
async function recordRecipientAttachments(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  campaign: { id: string; user_id: string; name: string },
  recipients: Array<{ id: string; email: string; name: string | null }>,
  prepared: PreparedAttachment[],
  mode: 'attachment' | 'link',
): Promise<void> {
  if (prepared.length === 0 || recipients.length === 0) return
  // recipient_attachments 는 recipient_email NOT NULL + link_url 컬럼 없음 (migration 004).
  // 즉시 발송 경로(useSendCampaign)와 동일하게 denormalized 컬럼을 채운다.
  const rows: Array<Record<string, unknown>> = []
  for (const rcpt of recipients) {
    for (const a of prepared) {
      rows.push({
        user_id: campaign.user_id,
        recipient_id: rcpt.id,
        campaign_id: campaign.id,
        recipient_email: rcpt.email,
        recipient_name: rcpt.name,
        campaign_name: campaign.name,
        attachment_id: a.id,
        delivery_mode: mode,
      })
    }
  }
  const { error } = await supabase
    .schema('mailcaster')
    .from('recipient_attachments')
    .insert(rows)
  if (error) {
    console.warn('[send-scheduled] recipient_attachments insert failed:', error.message)
  }
}

// ------------------------------------------------------------
// 069 — 발송 완료 후 후속 시퀀스 등록 (service_role). best-effort.
//   RPC enroll_campaign_recipients 가 'sent' 수신자를 캠페인 스레드 followup 으로 등록.
//   recipients.rfc_message_id 는 발송 시점에 채워둠(즉시·예약 동일) → followup In-Reply-To 연결.
// ------------------------------------------------------------
async function enrollFollowupSequence(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  campaign: Campaign,
): Promise<void> {
  if (!campaign.followup_sequence_id) return
  const { data, error } = await supabase
    .schema('mailcaster')
    .rpc('enroll_campaign_recipients', { p_campaign_id: campaign.id })
  if (error) {
    console.warn(`[send-scheduled] follow-up enroll failed for ${campaign.id}:`, error.message)
  } else if (data) {
    console.log(`[send-scheduled] campaign ${campaign.id} enrolled ${data} into follow-up sequence`)
  }
}

// 069 — 발송한 메일의 RFC822 Message-ID 조회 (후속 시퀀스 In-Reply-To/References 용).
//   best-effort — 실패 시 null (gmail_thread_id 만으로도 Gmail 스레드는 묶임).
//   후속 시퀀스가 붙은 캠페인에서만 호출해 평상시 발송엔 추가 API 비용이 없게 한다.
async function fetchMessageRfcId(accessToken: string, gmailMessageId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=Message-ID`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) return null
    const data = await res.json()
    const headers = data.payload?.headers ?? []
    const found = headers.find((h: { name: string }) => h.name.toLowerCase() === 'message-id')
    return found?.value ?? null
  } catch {
    return null
  }
}

// ============================================================
// Helpers
// ============================================================

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function buildVariables(r: Recipient): Record<string, string> {
  const base: Record<string, string> = { email: r.email, name: r.name ?? '' }
  if (r.variables && typeof r.variables === 'object') {
    for (const [k, v] of Object.entries(r.variables)) {
      base[k] = v == null ? '' : String(v)
    }
  }
  return base
}

function renderTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k]
    return v == null ? '' : String(v)
  })
}

function extractVariables(input: string): string[] {
  const set = new Set<string>()
  const re = /\{\{\s*([\w.]+)\s*\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) set.add(m[1])
  return Array.from(set)
}

// W5) transient 5xx / 네트워크 오류에 대해 지수 백오프 재시도.
//     401/400 은 refresh_token 자체 문제이므로 즉시 중단 (재시도해도 같은 결과).
async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      })
      if (res.ok) {
        const json = await res.json()
        if (!json.access_token) throw new Error('access_token 미반환')
        return json.access_token as string
      }
      const body = await res.text()
      // 4xx — refresh_token invalid / revoked. 재시도 무의미.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Google OAuth 실패 (${res.status}): ${body}`)
      }
      // 5xx — transient
      lastErr = new Error(`Google OAuth ${res.status}: ${body}`)
    } catch (e) {
      lastErr = e
      // 4xx 는 위에서 throw 했으므로 여기 도착 = network/5xx. 재시도 허용.
      if (e instanceof Error && e.message.startsWith('Google OAuth 실패')) throw e
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 300 * attempt)) // 300, 600ms
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('refreshGoogleToken failed')
}

// ============================================================
// Drive API 헬퍼 — src/lib/drive.ts 의 Deno 포트
// (필요한 3개만 인라인 구현: getFileMeta / downloadFile / shareAsPublicLink)
// ============================================================
const DRIVE_API = 'https://www.googleapis.com/drive/v3'

async function driveToError(res: Response): Promise<Error & { status: number }> {
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

async function driveGetMeta(accessToken: string, fileId: string): Promise<void> {
  // 메타 조회만 — 삭제 여부만 체크하면 되므로 최소 fields
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,trashed`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await driveToError(res)
  const j = await res.json()
  if (j.trashed) {
    const err = new Error('File trashed') as Error & { status: number }
    err.status = 404
    throw err
  }
}

async function driveDownload(accessToken: string, fileId: string): Promise<Blob> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await driveToError(res)
  return await res.blob()
}

async function driveShareAsPublicLink(accessToken: string, fileId: string): Promise<string> {
  // 1) permission 추가: role=reader, type=anyone
  const permRes = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }
  )
  if (!permRes.ok) throw await driveToError(permRes)

  // 2) webViewLink 조회
  const metaRes = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=webViewLink`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!metaRes.ok) throw await driveToError(metaRes)
  const j = await metaRes.json()
  if (!j.webViewLink) throw new Error('Drive 링크를 가져올 수 없습니다.')
  return j.webViewLink as string
}

// ============================================================
// Base64 인코딩 — Blob → unwrapped base64
// Deno 는 FileReader 가 없으므로 arrayBuffer + Uint8Array 경로 사용.
// 큰 파일 안전성: 32KB chunk 로 String.fromCharCode 호출해 call stack overflow 방지.
// ============================================================
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const u8 = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, Math.min(i + CHUNK, u8.length))
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return btoa(binary)
}

// ============================================================
// 링크 모드용 본문 섹션 (src/hooks/useSendCampaign.ts 와 동일 디자인)
// ============================================================
function buildLinkSection(items: PreparedAttachment[]): string {
  if (items.length === 0) return ''
  const listItems = items
    .map(
      (x) =>
        `<li style="margin:4px 0;"><a href="${escapeHtml(x.link ?? '')}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;">${escapeHtml(x.filename)}</a>${
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
// Phase 6 (C) — 오픈 추적 픽셀 (src/hooks/useSendCampaign.ts 와 동일 로직)
// ------------------------------------------------------------
function buildTrackingPixel(recipientId: string, campaignId: string): string {
  const url = `${SUPABASE_URL}/functions/v1/track-open?rid=${encodeURIComponent(recipientId)}&cid=${encodeURIComponent(campaignId)}`
  return `<img src="${url}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;overflow:hidden;" />`
}

function injectTrackingPixel(html: string, pixelHtml: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixelHtml}</body>`)
  }
  return html + pixelHtml
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ============================================================
// Gmail MIME 빌더 — src/lib/gmail.ts 의 Deno 포트
// 첨부 있으면 multipart/mixed, 없으면 text/html 단일 파트 (backward compat)
// ============================================================
interface MailAttachment {
  filename: string
  mimeType: string
  base64: string // unwrapped (76자 줄바꿈 없음, buildMime 에서 wrap)
}

interface GmailSendInput {
  accessToken: string
  from: string
  to: string
  toName?: string | null
  subject: string
  html: string
  cc?: string[]
  bcc?: string[]
  attachments?: MailAttachment[]
  inlineImages?: InlineImage[]
}

interface InlineImage {
  cid: string
  filename: string
  mimeType: string
  base64: string // unwrapped
}

// 본문의 <img src="..."> 를 base64 inline 으로 embed.
// 클라이언트 (src/lib/inlineImages.ts) 와 동일한 정책 — data URL / https URL 모두 fetch.
const INLINE_FETCH_TIMEOUT_MS = 10_000
const INLINE_MAX_IMAGE_BYTES = 8 * 1024 * 1024
const INLINE_MAX_TOTAL_BYTES = 20 * 1024 * 1024

async function extractAndInlineImages(
  html: string,
): Promise<{ html: string; images: InlineImage[] }> {
  if (!/<img\b[^>]*\bsrc=/i.test(html)) {
    return { html, images: [] }
  }
  const imgRe = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi
  const sources = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(html)) !== null) {
    sources.add(m[3])
  }
  const srcList = [...sources]
  const results = await Promise.allSettled(srcList.map((s) => fetchInline(s)))
  const srcToCid = new Map<string, string>()
  const images: InlineImage[] = []
  let totalBytes = 0
  let index = 1
  for (let i = 0; i < srcList.length; i++) {
    const r = results[i]
    if (r.status !== 'fulfilled' || !r.value) continue
    const img = r.value
    if (img.rawBytes > INLINE_MAX_IMAGE_BYTES) continue
    if (totalBytes + img.rawBytes > INLINE_MAX_TOTAL_BYTES) continue
    totalBytes += img.rawBytes
    const cid = `mc-img-${index++}-${crypto.randomUUID().slice(0, 8)}`
    srcToCid.set(srcList[i], cid)
    images.push({
      cid,
      filename: img.filename,
      mimeType: img.mimeType,
      base64: img.base64,
    })
  }
  const transformed = html.replace(imgRe, (full, before, _q, src, after) => {
    const cid = srcToCid.get(src)
    if (!cid) return full
    return `<img${before}src="cid:${cid}"${after}>`
  })
  return { html: transformed, images }
}

async function fetchInline(src: string): Promise<{
  filename: string
  mimeType: string
  base64: string
  rawBytes: number
} | null> {
  const dataMatch = src.match(/^data:([^;]+);base64,(.+)$/)
  if (dataMatch) {
    const mimeType = dataMatch[1]
    const base64 = dataMatch[2]
    const rawBytes = Math.ceil((base64.length * 3) / 4)
    return { filename: `inline.${extFromMime(mimeType)}`, mimeType, base64, rawBytes }
  }
  if (!/^https?:\/\//.test(src)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INLINE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(src, { signal: controller.signal })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? 'application/octet-stream'
    if (!ct.startsWith('image/')) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) return null
    const bytes = new Uint8Array(buf)
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    const base64 = btoa(bin)
    const filename = filenameFromUrl(src) ?? `inline.${extFromMime(ct)}`
    return { filename, mimeType: ct, base64, rawBytes: buf.byteLength }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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

function stripCRLF(s: string): string {
  // \ud5e4\ub354 \uc778\uc81d\uc158 \ubc29\uc9c0 \u2014 CR/LF/NUL/U+2028/U+2029 \uc81c\uac70. \uc758\ub3c4\ub41c \ucee8\ud2b8\ub864 \ubb38\uc790.
  // deno-lint-ignore no-control-regex
  return s.replace(/[\r\n\0\u2028\u2029]/g, '')
}

function encodeHeader(value: string): string {
  const clean = stripCRLF(value)
  // ASCII-only \uac80\uc0ac \u2014 RFC 2047 \uc778\ucf54\ub529 \ud544\uc694 \uc5ec\ubd80 \ud310\ub2e8. \uc758\ub3c4\ub41c \ucee8\ud2b8\ub864 \ubb38\uc790.
  // deno-lint-ignore no-control-regex
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean
  const enc = new TextEncoder()
  const MAX_BYTES = 42
  const parts: string[] = []
  let buf = ''
  let bufBytes = 0
  for (const ch of clean) {
    const chBytes = enc.encode(ch).length
    if (bufBytes + chBytes > MAX_BYTES && buf) {
      parts.push(`=?UTF-8?B?${utf8ToBase64(buf)}?=`)
      buf = ''
      bufBytes = 0
    }
    buf += ch
    bufBytes += chBytes
  }
  if (buf) parts.push(`=?UTF-8?B?${utf8ToBase64(buf)}?=`)
  return parts.join(' ')
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function wrapBase64(s: string, width = 76): string {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += width) chunks.push(s.slice(i, i + width))
  return chunks.join('\r\n')
}

function b64urlMime(mime: string): string {
  return utf8ToBase64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function joinAddressList(list: string[] | undefined): string | undefined {
  if (!list || list.length === 0) return undefined
  const cleaned = list
    .map((a) => encodeAddressHeader(stripCRLF(a).trim()))
    .filter(Boolean)
  return cleaned.length > 0 ? cleaned.join(', ') : undefined
}

/**
 * 본문에 시그니처가 이미 포함됐는지 plain-text fragment 로 판정.
 * src/lib/mailMerge.ts 의 bodyAlreadyContainsSignature 와 동일 정책 (즉시/예약 발송 일치).
 * (edge 런타임이라 lib import 불가 — 포트.)
 */
function bodyContainsSignature(bodyHtml: string, sigHtml: string): boolean {
  const strip = (h: string) =>
    h
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const bodyPlain = strip(bodyHtml)
  const sigPlain = strip(sigHtml)
  if (!sigPlain) return true
  if (sigPlain.length < 40) return bodyPlain.includes(sigPlain)
  return bodyPlain.includes(sigPlain.slice(0, 80))
}

/**
 * 주소 헤더 (From/Cc/Bcc 등) 의 display name 만 RFC 2047 인코딩.
 * 받는 클라이언트가 한글 등 비-ASCII 이름을 mojibake 로 표시하지 않도록.
 */
function encodeAddressHeader(addr: string): string {
  const m = addr.match(/^\s*(.+?)\s*<([^>]+)>\s*$/)
  if (!m) return addr
  const name = m[1].trim().replace(/^"(.*)"$/, '$1')
  const email = m[2].trim()
  if (!name) return `<${email}>`
  // deno-lint-ignore no-control-regex
  if (/^[\x20-\x7E]+$/.test(name) && !/[<>"@,;:\\]/.test(name)) {
    return `${name} <${email}>`
  }
  return `${encodeHeader(name)} <${email}>`
}

// RFC 5987 / 2231 — 비-ASCII filename 파라미터
function encodeRFC2231(value: string): string {
  return `UTF-8''${encodeURIComponent(value).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/**
 * filename / name 파라미터 — 한글 등 비-ASCII 파일명이 Gmail UI 에서 underscore
 * 로 깨지지 않도록. filename= 에 RFC 2047 encoded-word (=?UTF-8?B?...?=) 사용.
 * 비표준이지만 Gmail/Outlook/Apple Mail 모두 디코딩하는 de-facto 표준.
 * filename*= (RFC 5987) 도 함께 — 표준 따르는 신형 클라이언트 우선용.
 */
function dispositionFilename(filename: string): string {
  const clean = stripCRLF(filename)
  // deno-lint-ignore no-control-regex
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `filename="${clean}"`
  return `filename="${encodeOneWordForParam(clean)}"; filename*=${encodeRFC2231(clean)}`
}

function contentTypeName(filename: string): string {
  const clean = stripCRLF(filename)
  // deno-lint-ignore no-control-regex
  const asciiSafe = /^[\x20-\x7E]*$/.test(clean) && !/["\\]/.test(clean)
  if (asciiSafe) return `name="${clean}"`
  return `name="${encodeOneWordForParam(clean)}"; name*=${encodeRFC2231(clean)}`
}

// 짧은 문자열용 single encoded-word (75자 한도 안에 들어가는 일반 파일명에는 충분).
function encodeOneWordForParam(s: string): string {
  return `=?UTF-8?B?${utf8ToBase64(s)}?=`
}

function buildMime(input: Omit<GmailSendInput, 'accessToken'>): string {
  const { from, to, toName, subject, html, cc, bcc, attachments, inlineImages } = input
  const cleanFrom = encodeAddressHeader(stripCRLF(from))
  const cleanTo = stripCRLF(to)
  const ccLine = joinAddressList(cc)
  const bccLine = joinAddressList(bcc)
  const toHeader = toName ? `${encodeHeader(toName)} <${cleanTo}>` : cleanTo
  const bodyBase64 = wrapBase64(utf8ToBase64(html))

  const baseHeaders: string[] = [`From: ${cleanFrom}`, `To: ${toHeader}`]
  if (ccLine) baseHeaders.push(`Cc: ${ccLine}`)
  if (bccLine) baseHeaders.push(`Bcc: ${bccLine}`)
  baseHeaders.push(`Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0')

  const hasInline = inlineImages && inlineImages.length > 0
  const hasAttachments = attachments && attachments.length > 0

  // 둘 다 없으면 단일 text/html
  if (!hasInline && !hasAttachments) {
    const headers = [
      ...baseHeaders,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ]
    return headers.join('\r\n') + '\r\n\r\n' + bodyBase64
  }

  const newBoundary = () => `MC_${crypto.randomUUID().replace(/-/g, '')}`

  // 일반 첨부 없고 inline 만 있으면 top-level 이 multipart/related.
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

  // 일반 첨부 있는 경우 — 본문/inline 묶음을 multipart/related 로, 그리고 multipart/mixed 로 감쌈.
  const topBoundary = newBoundary()
  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${topBoundary}"`,
  ]
  const parts: string[] = [`--${topBoundary}`]
  if (hasInline) {
    const innerBoundary = newBoundary()
    parts.push(`Content-Type: multipart/related; boundary="${innerBoundary}"`, '')
    parts.push(
      `--${innerBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
    )
    for (const img of inlineImages!) {
      parts.push(
        `--${innerBoundary}`,
        `Content-Type: ${img.mimeType}; ${contentTypeName(img.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: inline; ${dispositionFilename(img.filename)}`,
        `Content-ID: <${img.cid}>`,
        '',
        wrapBase64(img.base64),
      )
    }
    parts.push(`--${innerBoundary}--`)
  } else {
    parts.push(
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64,
    )
  }
  for (const att of attachments!) {
    parts.push(
      `--${topBoundary}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; ${contentTypeName(att.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(att.filename)}`,
      '',
      wrapBase64(att.base64),
    )
  }
  parts.push(`--${topBoundary}--`, '')
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
}

async function sendGmail(input: GmailSendInput): Promise<{ id: string; threadId: string }> {
  const mime = buildMime(input)
  const raw = b64urlMime(mime)
  // 명시적 25초 타임아웃 — Gmail 이 hang 하면 RUN_BUDGET_MS(50초) 안에 다른
  // recipient 처리를 못 하고 함수가 통째로 죽음. 부분 진행 보존을 위해 단일 호출
  // 상한을 둠. Supabase Edge 의 hard timeout(60초) 보다 짧게.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  let res: Response
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
      signal: controller.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      const err = new Error('Gmail API 호출 타임아웃 (25초 초과)') as Error & { status?: number }
      err.status = 504
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
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
  return await res.json()
}
