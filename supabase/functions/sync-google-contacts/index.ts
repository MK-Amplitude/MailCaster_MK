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
import { decryptToken } from '../_shared/tokenCrypto.ts'

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

    let body: { force_full?: boolean; target_user_id?: string; org_id?: string } = {}
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

    // 사용자 프로필 — refresh token + 조직 + sync token (+ 기타 주소록 설정)
    const { data: profile, error: pErr } = await admin
      .schema('mailcaster')
      .from('profiles')
      .select(
        'id, google_refresh_token, google_contacts_sync_token, google_contacts_include_other, google_contacts_other_sync_token'
      )
      .eq('id', userId)
      .single()
    if (pErr) throw pErr
    if (!profile?.google_refresh_token) {
      return json({ error: 'Google 재로그인이 필요합니다.' }, 401)
    }

    // 대상 조직 결정 — 클라이언트가 보낸 org_id (현재 선택된 조직) 우선.
    // 멀티 조직 사용자의 경우 org_members 첫 행이 임의라 UI 의 현재 조직과 다른 곳에
    // 연락처가 들어가는 버그가 있었음 — org_id 를 명시 받고 멤버십을 검증한다.
    let orgId: string
    if (body.org_id) {
      const { data: membership } = await admin
        .schema('mailcaster')
        .from('org_members')
        .select('org_id')
        .eq('user_id', userId)
        .eq('org_id', body.org_id)
        .maybeSingle()
      if (!membership?.org_id) {
        return json({ error: '이 조직의 멤버가 아닙니다.' }, 403)
      }
      orgId = membership.org_id as string
    } else {
      // 하위 호환 (cron 등 org_id 미전달) — 첫 멤버십 사용
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
      orgId = membership.org_id as string
    }

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
    let useSyncToken = !body.force_full && !!profile.google_contacts_sync_token
    const connections: PeopleConnection[] = []
    let pageToken: string | undefined = undefined
    let nextSyncToken: string | null = null
    let scopeMissing = false
    let apiDisabled = false
    let lastErrorDetail: string | null = null
    let syncTokenRetried = false

    // 주의: do…while(pageToken) 구조에서 continue 는 조건 검사로 점프해
    // pageToken=undefined 인 재시도가 루프를 그냥 종료시킨다 — while(true) + 명시 break 사용.
    while (true) {
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
      // syncToken 만료 — People API 는 400 FAILED_PRECONDITION (EXPIRED_SYNC_TOKEN) 을
      // 반환한다 (410 은 다른 Google API 계열의 관례 — 방어적으로 둘 다 처리).
      // 서버에서 즉시 full sync 로 전환해 재시도 — 클라이언트 왕복 없이 한 번에 처리.
      if (res.status === 410 || res.status === 400) {
        const bodyText = await res.text()
        const isExpiredToken =
          res.status === 410 || /EXPIRED_SYNC_TOKEN|Sync token is expired/i.test(bodyText)
        if (isExpiredToken && useSyncToken && !syncTokenRetried) {
          console.warn('[sync-google-contacts] sync token expired — full sync 으로 전환')
          syncTokenRetried = true
          useSyncToken = false
          connections.length = 0
          pageToken = undefined
          nextSyncToken = null
          continue
        }
        throw new Error(`People API ${res.status}: ${bodyText.slice(0, 300)}`)
      }
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`People API ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = await res.json()
      if (Array.isArray(data.connections)) connections.push(...data.connections)
      pageToken = data.nextPageToken
      if (data.nextSyncToken) nextSyncToken = data.nextSyncToken
      if (!pageToken) break
    }

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

    // ── 기타 주소록 (Other contacts) — opt-in ─────────────────────
    // Gmail 이 자동 수집한 상대는 connections 에 없음 → otherContacts.list 로 별도 수집.
    // contacts.other.readonly scope 필요 — 미부여 시 other_scope_missing 플래그만 반환
    // (메인 동기화 결과는 정상 처리).
    let otherScopeMissing = false
    let otherNextSyncToken: string | null = null
    const includeOther = profile.google_contacts_include_other === true
    if (includeOther) {
      // 전체를 try 로 격리 — otherContacts 의 어떤 실패(5xx/네트워크)도
      // 이미 수집한 메인 connections 동기화를 무산시키지 않는다.
      try {
        let useOtherToken = !body.force_full && !!profile.google_contacts_other_sync_token
        let otherPageToken: string | undefined = undefined
        let otherRetried = false
        while (true) {
          const params = new URLSearchParams({
            // otherContacts 는 personFields 가 아니라 readMask, 지원 필드도 제한적
            readMask: 'names,emailAddresses,phoneNumbers,metadata',
            pageSize: '1000',
            requestSyncToken: 'true',
          })
          if (otherPageToken) params.set('pageToken', otherPageToken)
          else if (useOtherToken) {
            params.set('syncToken', profile.google_contacts_other_sync_token as string)
          }
          const res = await fetch(
            `https://people.googleapis.com/v1/otherContacts?${params.toString()}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          )
          if (res.status === 401 || res.status === 403) {
            // scope 누락과 일시적 인증 오류 구분 — scope 계열 메시지일 때만 재로그인 안내
            const bodyText = await res.text().catch(() => '')
            if (/insufficient|scope|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(bodyText)) {
              otherScopeMissing = true
              console.warn('[sync-google-contacts] otherContacts scope missing')
            } else {
              console.warn('[sync-google-contacts] otherContacts auth transient:', res.status, bodyText.slice(0, 150))
            }
            break
          }
          if (res.status === 410 || res.status === 400) {
            const bodyText = await res.text()
            const expired =
              res.status === 410 || /EXPIRED_SYNC_TOKEN|Sync token is expired/i.test(bodyText)
            if (expired && useOtherToken && !otherRetried) {
              otherRetried = true
              useOtherToken = false
              otherPageToken = undefined
              otherNextSyncToken = null
              continue
            }
            throw new Error(`People otherContacts ${res.status}: ${bodyText.slice(0, 300)}`)
          }
          if (!res.ok) {
            const bodyText = await res.text()
            throw new Error(`People otherContacts ${res.status}: ${bodyText.slice(0, 300)}`)
          }
          const data = await res.json()
          // 응답 shape 은 connections 과 동일 (names/emailAddresses/phoneNumbers/metadata)
          if (Array.isArray(data.otherContacts)) connections.push(...data.otherContacts)
          otherPageToken = data.nextPageToken
          if (data.nextSyncToken) otherNextSyncToken = data.nextSyncToken
          if (!otherPageToken) break
        }
      } catch (e) {
        // 실패해도 메인 동기화는 계속 — 토큰 미저장이라 다음 실행에서 재시도됨
        otherNextSyncToken = null
        console.warn(
          '[sync-google-contacts] otherContacts sync failed (main sync unaffected):',
          e instanceof Error ? e.message : e,
        )
      }
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

    // 진단 — 같은 이메일이 이 사용자의 "다른 조직" 에 존재하는 수.
    // 과거 org 선택 버그로 잘못된 조직에 들어간 연락처를 찾아내기 위한 지표.
    // 비용 절감: 신규 삽입이 0 인데 가져온 행이 있을 때만 (의심 상황에서만) 조회.
    let inOtherOrg = 0
    if (rows.length > 0 && inserted === 0) {
      const emails = rows.map((r) => r.email)
      for (let i = 0; i < emails.length; i += 500) {
        const { count } = await admin
          .schema('mailcaster')
          .from('contacts')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .neq('org_id', orgId)
          .in('email', emails.slice(i, i + 500))
        inOtherOrg += count ?? 0
      }
    }

    // sync token 저장 — 배치 upsert 오류가 하나라도 있으면 저장하지 않는다.
    // 저장하면 다음 incremental 이 델타만 반환해 실패한 배치의 연락처가
    // force_full 전까지 영구 누락됨. (connections / otherContacts 토큰 각각)
    const profileUpdates: Record<string, unknown> = {
      google_contacts_last_sync_at: new Date().toISOString(),
    }
    if (errors.length === 0) {
      if (nextSyncToken) profileUpdates.google_contacts_sync_token = nextSyncToken
      if (otherNextSyncToken) profileUpdates.google_contacts_other_sync_token = otherNextSyncToken
    }
    await admin
      .schema('mailcaster')
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)

    return json({
      inserted,
      duplicates,
      deleted_skipped: deletedSkipped,
      total_fetched: connections.length,
      in_other_org: inOtherOrg,
      other_scope_missing: otherScopeMissing,
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

async function refreshGoogleToken(storedToken: string): Promise<string> {
  // DB 에 암호화되어 저장된 토큰 복호화 (평문 저장 기존 토큰도 그대로 통과)
  const refreshToken = await decryptToken(storedToken)
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
