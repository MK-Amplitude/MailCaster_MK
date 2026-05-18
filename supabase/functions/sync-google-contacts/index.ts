// Supabase Edge Function: sync-google-contacts
//
// 리멤버 → 구글 주소록 자동 저장 → MailCaster contacts 테이블 incremental sync.
//
// 흐름:
//   1) profile.google_refresh_token 으로 People API access token 발급
//   2) /v1/people/me/connections?syncToken=... 으로 페이지네이션 수집
//   3) email 가진 행만 upsert (onConflict: user_id+email, ignoreDuplicates=true)
//      → 기존 데이터 절대 덮어쓰지 않음 (사용자 정책)
//   4) 응답 nextSyncToken 을 profile 에 저장 → 다음 호출은 incremental
//
// 호출 경로:
//   - 사용자 JWT (Settings 의 "지금 동기화" 버튼)
//   - CRON_SECRET (자동 동기화 cron — 추후)
//
// 입력: { force_full?: boolean }  (force_full=true 면 syncToken 무시하고 full sync)
// 출력: { inserted, duplicates, errors, scope_missing? }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,memberships,metadata'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface PeopleConnection {
  resourceName?: string
  metadata?: {
    deleted?: boolean
    sources?: Array<{ id?: string }>
  }
  names?: Array<{ displayName?: string; familyName?: string; givenName?: string; metadata?: { primary?: boolean } }>
  emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }>
  phoneNumbers?: Array<{ value?: string; metadata?: { primary?: boolean } }>
  organizations?: Array<{ name?: string; title?: string; department?: string; metadata?: { primary?: boolean } }>
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '인증 필요' }, 401)

    let body: { force_full?: boolean; target_user_id?: string } = {}
    try {
      const text = await req.text()
      if (text) body = JSON.parse(text)
    } catch {
      // 빈 본문도 허용
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // 인증 — 사용자 JWT 또는 CRON_SECRET.
    const isCron = !!CRON_SECRET && auth === `Bearer ${CRON_SECRET}`
    let userId: string
    if (isCron) {
      if (!body.target_user_id) {
        return json({ error: 'CRON 경로는 target_user_id 필수' }, 400)
      }
      userId = body.target_user_id
    } else {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false },
      })
      const { data: userData, error: userErr } = await userClient.auth.getUser()
      if (userErr || !userData?.user?.id) return json({ error: '인증 실패' }, 401)
      userId = userData.user.id
    }

    // 사용자 프로필 — refresh token + 조직 + sync token
    const { data: profile, error: pErr } = await admin
      .schema('mailcaster')
      .from('profiles')
      .select('id, google_refresh_token, google_contacts_sync_token')
      .eq('id', userId)
      .single()
    if (pErr) throw pErr
    if (!profile?.google_refresh_token) {
      return json({ error: 'Google 재로그인이 필요합니다.' }, 401)
    }

    // 현재 활성 조직 — org_members 의 첫 행 (사용자가 여러 조직이면 향후 명시 받기)
    const { data: membership } = await admin
      .schema('mailcaster')
      .from('org_members')
      .select('org_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    if (!membership?.org_id) {
      return json({ error: '조직 정보가 없습니다.' }, 400)
    }
    const orgId = membership.org_id as string

    // access_token 발급
    let accessToken: string
    try {
      accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return json({ error: `Google 토큰 갱신 실패: ${msg}`, scope_missing: false }, 401)
    }

    // 페이지네이션으로 모든 connections 수집.
    // force_full 이면 syncToken 무시 → 전체 sync. 그 외엔 incremental.
    const useSyncToken = !body.force_full && !!profile.google_contacts_sync_token
    const connections: PeopleConnection[] = []
    let pageToken: string | undefined = undefined
    let nextSyncToken: string | null = null
    let scopeMissing = false
    let apiDisabled = false
    let lastErrorDetail: string | null = null

    do {
      const params = new URLSearchParams({
        personFields: PERSON_FIELDS,
        pageSize: '1000',
        requestSyncToken: 'true',
      })
      if (pageToken) params.set('pageToken', pageToken)
      else if (useSyncToken) params.set('syncToken', profile.google_contacts_sync_token as string)

      const res = await fetch(
        `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (res.status === 401 || res.status === 403) {
        // 정확한 원인 분리 — Google 응답 body 의 error.message / reason / status 로 판정.
        let errBody: { error?: { message?: string; status?: string; details?: unknown[] } } = {}
        try {
          errBody = await res.json()
        } catch {
          errBody = {}
        }
        const msg = errBody.error?.message ?? ''
        const status = errBody.error?.status ?? ''
        lastErrorDetail = `${res.status} ${status}: ${msg.slice(0, 240)}`
        console.warn('[sync-google-contacts] auth/forbidden:', lastErrorDetail)
        // People API 미활성화 — GCP 콘솔에서 enable 필요
        if (
          /SERVICE_DISABLED|has not been used|disabled/i.test(msg) ||
          status === 'PERMISSION_DENIED' && /API/i.test(msg)
        ) {
          apiDisabled = true
        } else {
          // 그 외 401/403 은 scope 누락 또는 토큰 무효
          scopeMissing = true
        }
        break
      }
      if (res.status === 410) {
        // syncToken 만료 → full sync 재시도
        return json({
          error: 'sync_token_expired',
          retry_with_force_full: true,
        }, 410)
      }
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`People API ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = await res.json()
      if (Array.isArray(data.connections)) connections.push(...data.connections)
      pageToken = data.nextPageToken
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken
    } while (pageToken)

    if (apiDisabled) {
      return json({
        api_disabled: true,
        inserted: 0,
        duplicates: 0,
        deleted_skipped: 0,
        detail: lastErrorDetail,
        message: 'Google Cloud 콘솔에서 People API 를 활성화해주세요.',
      })
    }

    if (scopeMissing) {
      return json({
        scope_missing: true,
        inserted: 0,
        duplicates: 0,
        deleted_skipped: 0,
        detail: lastErrorDetail,
        message: 'Google Contacts 권한이 없습니다. 재로그인 필요.',
      })
    }

    // 변환 + upsert
    let inserted = 0
    let duplicates = 0
    let deletedSkipped = 0
    const errors: Array<{ email?: string; message: string }> = []

    // 삭제된 행은 skip (incremental sync 시 metadata.deleted=true 로 옴)
    const rows = connections
      .filter((c) => !c.metadata?.deleted)
      .map((c) => connectionToContactRow(c, userId, orgId))
      .filter((r): r is NonNullable<ReturnType<typeof connectionToContactRow>> => !!r)

    deletedSkipped = connections.filter((c) => c.metadata?.deleted).length

    // 배치 upsert
    const BATCH = 200
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { data, error } = await admin
        .schema('mailcaster')
        .from('contacts')
        .upsert(slice, { onConflict: 'user_id,email', ignoreDuplicates: true })
        .select('id, email')
      if (error) {
        errors.push({ message: error.message })
        continue
      }
      const insertedCount = (data ?? []).length
      inserted += insertedCount
      duplicates += slice.length - insertedCount
    }

    // sync token 저장
    if (nextSyncToken) {
      await admin
        .schema('mailcaster')
        .from('profiles')
        .update({
          google_contacts_sync_token: nextSyncToken,
          google_contacts_last_sync_at: new Date().toISOString(),
        })
        .eq('id', userId)
    } else {
      // 응답에 syncToken 이 없으면 last_sync_at 만 갱신
      await admin
        .schema('mailcaster')
        .from('profiles')
        .update({ google_contacts_last_sync_at: new Date().toISOString() })
        .eq('id', userId)
    }

    return json({
      inserted,
      duplicates,
      deleted_skipped: deletedSkipped,
      total_fetched: connections.length,
      errors,
      sync_token_updated: !!nextSyncToken,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[sync-google-contacts] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// People API connection → MailCaster contacts row.
// primary 우선 email/name/phone, organizations[0] 의 name/title.
// email 없으면 null (caller 가 skip).
function connectionToContactRow(
  c: PeopleConnection,
  userId: string,
  orgId: string,
): {
  user_id: string
  org_id: string
  email: string
  name: string | null
  company: string | null
  company_raw: string | null
  company_lookup_status: 'pending' | 'skipped'
  job_title: string | null
  department: string | null
  phone: string | null
} | null {
  const email = pickPrimary(c.emailAddresses)?.value?.trim().toLowerCase()
  if (!email) return null
  // 매우 간단한 email 형식 검증 — '@' 포함 + dot 포함
  if (!email.includes('@') || !email.includes('.')) return null

  const nameObj = pickPrimary(c.names)
  const name = nameObj?.displayName?.trim() || null
  const phone = pickPrimary(c.phoneNumbers)?.value?.trim() || null
  const org = pickPrimary(c.organizations)
  const company = org?.name?.trim() || null
  const title = org?.title?.trim() || null
  const department = org?.department?.trim() || null

  return {
    user_id: userId,
    org_id: orgId,
    email,
    name,
    company,
    company_raw: company,
    company_lookup_status: company ? 'pending' : 'skipped',
    job_title: title,
    department,
    phone,
  }
}

function pickPrimary<T extends { metadata?: { primary?: boolean } }>(
  arr: T[] | undefined,
): T | undefined {
  if (!arr || arr.length === 0) return undefined
  return arr.find((x) => x.metadata?.primary) ?? arr[0]
}

async function refreshGoogleToken(refreshToken: string): Promise<string> {
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
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google OAuth ${res.status}: ${body.slice(0, 200)}`)
  }
  const j = await res.json()
  if (!j.access_token) throw new Error('no access_token')
  return j.access_token as string
}
