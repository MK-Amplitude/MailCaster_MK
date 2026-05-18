// Supabase Edge Function: outreach-sync-mailing
//
// 메일 발송 성공 후 호출 — 해당 recipient 를 Outreach prospect 의 activity 로 기록.
//   1) profile.outreach_refresh_token 확인 + 만료 임박 시 refresh
//   2) prospect lookup by email → 없으면 create
//   3) mailing record 생성 (state='delivered', body 첨부)
//   4) recipients.outreach_mailing_id 에 결과 저장 (재호출 시 dedup)
//
// 호출 경로:
//   - 즉시 발송 (useSendCampaign): 각 수신자 성공 직후 fire-and-forget
//   - 예약 발송 (send-scheduled-campaigns cron): INDIVIDUAL 루프에서 동일
//   - 수동 백필 (Settings 의 "과거 발송 Outreach 동기화" 버튼): bulk 호출
//
// 입력:
//   { recipient_ids: string[] }  +  Bearer <user_jwt>  또는  Bearer <CRON_SECRET>
//
// 출력:
//   { synced: number, skipped: number, errors: number, details?: [...] }

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  refreshOutreachToken,
  findProspectByEmail,
  createProspect,
  createMailing,
  isTokenExpiringSoon,
  computeExpiresAt,
} from '../_shared/outreach.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const OUTREACH_CLIENT_ID = Deno.env.get('OUTREACH_CLIENT_ID') ?? ''
const OUTREACH_CLIENT_SECRET = Deno.env.get('OUTREACH_CLIENT_SECRET') ?? ''
const OUTREACH_REDIRECT_URI = Deno.env.get('OUTREACH_REDIRECT_URI') ?? ''
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  recipient_ids: z.array(z.string().uuid()).min(1).max(500),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    if (!OUTREACH_CLIENT_ID || !OUTREACH_CLIENT_SECRET) {
      return json({ error: 'Outreach OAuth 가 서버에 설정되지 않았습니다.' }, 500)
    }

    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '인증 필요' }, 401)

    let parsed: z.infer<typeof RequestSchema>
    try {
      parsed = RequestSchema.parse(await req.json())
    } catch (e) {
      const msg = e instanceof z.ZodError
        ? e.errors[0]?.message ?? '잘못된 요청'
        : '요청 본문을 읽을 수 없습니다.'
      return json({ error: msg }, 400)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 인증 — 사용자 JWT 또는 CRON_SECRET 둘 다 허용.
    // CRON 경로는 cron / 다른 edge function 에서 fire-and-forget 호출용.
    const isCron = !!CRON_SECRET && auth === `Bearer ${CRON_SECRET}`
    let restrictUserId: string | null = null
    if (!isCron) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false },
      })
      const { data: userData, error: userErr } = await userClient.auth.getUser()
      if (userErr || !userData?.user?.id) return json({ error: '인증 실패' }, 401)
      restrictUserId = userData.user.id
    }

    // recipient + campaign + sender profile 조회.
    // gmail_message_id 가 있어야 (실제 발송된 메일) 동기화 가능.
    // outreach_mailing_id 가 NULL 인 것만 처리 (idempotent).
    const { data: rows, error: rErr } = await admin
      .schema('mailcaster')
      .from('recipients')
      .select(`
        id, email, name, subject_override, body_html_override, sent_at,
        outreach_mailing_id,
        campaign:campaigns!inner(
          id, user_id, subject, body_html
        )
      `)
      .in('id', parsed.recipient_ids)
      .not('gmail_message_id', 'is', null)
      .is('outreach_mailing_id', null)

    if (rErr) throw rErr
    const recipients = (rows ?? []) as Array<{
      id: string
      email: string
      name: string | null
      subject_override: string | null
      body_html_override: string | null
      sent_at: string | null
      outreach_mailing_id: number | null
      campaign: {
        id: string
        user_id: string
        subject: string | null
        body_html: string | null
      }
    }>

    if (recipients.length === 0) {
      return json({ synced: 0, skipped: parsed.recipient_ids.length, errors: 0 })
    }

    // user_id 별 그룹핑 — 토큰 한 번에 refresh.
    const byUser = new Map<string, typeof recipients>()
    for (const r of recipients) {
      if (restrictUserId && r.campaign.user_id !== restrictUserId) continue
      const arr = byUser.get(r.campaign.user_id) ?? []
      arr.push(r)
      byUser.set(r.campaign.user_id, arr)
    }

    let synced = 0
    let skipped = parsed.recipient_ids.length - recipients.length
    let errors = 0
    const details: Array<{ recipient_id: string; outreach_mailing_id?: number; error?: string }> = []

    for (const [userId, list] of byUser) {
      // 사용자 프로필 + outreach 토큰
      const { data: profile } = await admin
        .schema('mailcaster')
        .from('profiles')
        .select(
          'outreach_access_token, outreach_refresh_token, outreach_token_expires_at',
        )
        .eq('id', userId)
        .single()
      if (!profile?.outreach_refresh_token) {
        // 연결 안 된 사용자 — 모두 skip
        skipped += list.length
        for (const r of list) {
          details.push({ recipient_id: r.id, error: 'outreach_not_connected' })
        }
        continue
      }

      // 토큰 만료 임박 시 사전 refresh
      let accessToken = profile.outreach_access_token as string | null
      if (!accessToken || isTokenExpiringSoon(profile.outreach_token_expires_at as string | null)) {
        try {
          const refreshed = await refreshOutreachToken({
            clientId: OUTREACH_CLIENT_ID,
            clientSecret: OUTREACH_CLIENT_SECRET,
            refreshToken: profile.outreach_refresh_token as string,
            redirectUri: OUTREACH_REDIRECT_URI,
          })
          accessToken = refreshed.access_token
          await admin
            .schema('mailcaster')
            .from('profiles')
            .update({
              outreach_access_token: refreshed.access_token,
              outreach_refresh_token: refreshed.refresh_token,
              outreach_token_expires_at: computeExpiresAt(refreshed.expires_in),
            })
            .eq('id', userId)
        } catch (e) {
          // refresh 실패 — 이 사용자의 모든 row 를 error 로 기록 후 continue
          const msg = e instanceof Error ? e.message : String(e)
          errors += list.length
          for (const r of list) {
            details.push({ recipient_id: r.id, error: `token_refresh: ${msg}` })
            await admin
              .schema('mailcaster')
              .from('recipients')
              .update({ outreach_sync_error: `token_refresh: ${msg.slice(0, 200)}` })
              .eq('id', r.id)
          }
          continue
        }
      }

      // 각 recipient 처리
      for (const r of list) {
        try {
          // 1) prospect lookup
          let prospect = await findProspectByEmail(accessToken!, r.email)
          if (!prospect) {
            // 이름 분리 — "홍길동" → first=홍 last=길동 단순 split. 어색하면 firstName 만.
            const fullName = (r.name ?? '').trim()
            const space = fullName.indexOf(' ')
            const firstName = space > 0 ? fullName.slice(0, space) : fullName || null
            const lastName = space > 0 ? fullName.slice(space + 1) : null
            prospect = await createProspect(accessToken!, {
              email: r.email,
              firstName,
              lastName,
            })
          }

          // 2) mailing 생성
          const subject = (r.subject_override ?? r.campaign.subject ?? '').trim() || '(no subject)'
          const bodyHtml = r.body_html_override ?? r.campaign.body_html ?? ''
          const mailing = await createMailing(accessToken!, {
            prospectId: prospect.id,
            subject,
            bodyHtml,
            sentAt: r.sent_at ?? new Date().toISOString(),
          })

          // 3) recipient 업데이트
          await admin
            .schema('mailcaster')
            .from('recipients')
            .update({
              outreach_mailing_id: mailing.id,
              outreach_synced_at: new Date().toISOString(),
              outreach_sync_error: null,
            })
            .eq('id', r.id)

          synced++
          details.push({ recipient_id: r.id, outreach_mailing_id: mailing.id })
        } catch (e) {
          errors++
          const msg = e instanceof Error ? e.message : String(e)
          console.warn('[outreach-sync] recipient', r.id, 'failed:', msg)
          await admin
            .schema('mailcaster')
            .from('recipients')
            .update({ outreach_sync_error: msg.slice(0, 500) })
            .eq('id', r.id)
          details.push({ recipient_id: r.id, error: msg })
        }
      }
    }

    return json({ synced, skipped, errors, details })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[outreach-sync] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
