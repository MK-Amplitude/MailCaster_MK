// Supabase Edge Function: sync-google-contacts
//
// 리멤버 → 구글 주소록 자동 저장 → MailCaster contacts 테이블 incremental sync.
//
// 흐름:
//   1) profile.google_refresh_token 으로 People API access token 발급
//   2) /v1/people/me/connections?syncToken=... 으로 페이지네이션 수집
//   3) 페이지 단위로 즉시 upsert (onConflict: user_id+email, ignoreDuplicates=true)
//      → 기존 데이터 절대 덮어쓰지 않음 (사용자 정책)
//      → 전체 연락처를 메모리에 쌓지 않음 (페이지(≤1000건)만 보유)
//   4) 각 페이지 저장 성공 시 진행 상태(체크포인트)를 profile 에 저장,
//      마지막 페이지의 nextSyncToken 을 저장 → 다음 호출은 incremental
//
// 실행 예산 (RUN_BUDGET_MS ≈ 100초):
//   Edge Function wall-clock 한도(150초) 전에 스스로 멈춘다. 예산을 넘기면 다음 페이지를
//   가져오지 않고 종료 → 저장된 체크포인트에서 다음 실행(수동/cron)이 이어서 진행.
//   과거에는 sync token 을 맨 끝에만 저장해, 대용량 full sync 가 강제 종료되면
//   매시간 처음부터 full sync 를 반복하며 nano DB 에 수천 건 upsert 를 반복했다.
//
// 체크포인트 저장 형식 (별도 컬럼 없이 기존 sync token 컬럼 재사용):
//   google_contacts_sync_token / google_contacts_other_sync_token =
//     - '<People API syncToken>'                         — 완료 상태 (incremental 기준점)
//     - 'resume:{"v":1,"page":"<pageToken>","base":<syncToken|null>}'
//                                                        — 페이지 중간에서 멈춘 상태
//   resume 페이지 토큰이 만료/무효(400/410)면 base 기준으로 처음부터 다시 수집.
//
// 호출 경로:
//   - 사용자 JWT (Settings 의 "지금 동기화" 버튼) — org_id 필수 (현재 선택 조직)
//   - CRON_SECRET (자동 동기화 cron, 040 dispatch_google_contacts_sync) — target_user_id 필수,
//     org_id 는 선택 (보내면 멤버십 검증 후 사용)
//
// 입력: { force_full?: boolean, org_id?: string, target_user_id?: string }
//   (force_full=true 면 syncToken·체크포인트 무시하고 full sync)
// 출력: { inserted, duplicates, errors, scope_missing?, partial? }
//   partial=true — 실행 예산 초과로 중간 종료, 다음 실행에서 이어서 진행

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { isCronAuthorized } from '../_shared/cronAuth.ts'
import { decryptToken } from '../_shared/tokenCrypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,memberships,metadata'
// otherContacts 는 personFields 가 아니라 readMask, 지원 필드도 제한적
const OTHER_READ_MASK = 'names,emailAddresses,phoneNumbers,metadata'

// 실행 예산 — wall-clock 150초 한도 대비 여유를 둔다 (마지막 페이지 처리 + 응답 시간).
const RUN_BUDGET_MS = 100_000
// 외부 호출(People API / OAuth) 1건 타임아웃 — 응답이 멈춰도 예산 안에서 실패 처리.
const FETCH_TIMEOUT_MS = 10_000
const UPSERT_BATCH = 200
const CHECKPOINT_PREFIX = 'resume:'

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

type TokenColumn = 'google_contacts_sync_token' | 'google_contacts_other_sync_token'

interface PagedSyncOptions {
  label: string
  url: string
  fieldParam: [string, string]
  itemsKey: 'connections' | 'otherContacts'
  column: TokenColumn
  stored: string | null
  forceFull: boolean
  deadline: number
  // 페이지 저장 — 모든 배치가 성공하면 true (false 면 체크포인트를 더 진행하지 않음)
  processPage: (items: PeopleConnection[]) => Promise<boolean>
  saveToken: (column: TokenColumn, value: string) => Promise<void>
}

interface PagedSyncOutcome {
  completed: boolean // 마지막 페이지까지 처리함
  outOfBudget: boolean // 실행 예산 초과로 중간 종료 (체크포인트에서 재개)
  authError: { status: number; body: string } | null
  syncTokenSaved: boolean
  resumed: boolean // 이전 실행의 체크포인트에서 이어서 시작함
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const deadline = Date.now() + RUN_BUDGET_MS

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
    const isCron = isCronAuthorized(auth, CRON_SECRET)
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
      // 하위 호환 (cron 등 org_id 미전달) — 결정적 선택: 가장 오래된 멤버십
      // (joined_at ASC, 동률이면 org_id ASC). 보통 가입 시 자동 생성된 개인 워크스페이스
      // (016 trg_create_personal_org) 이며, 018 의 "유저 대표 조직" 선택 규칙과 동일.
      // 정렬 없는 limit(1) 은 실행마다 다른 조직을 고를 수 있어 쓰지 않는다.
      // (contacts 는 user_id+email 로 유일하므로, 조직 선택은 "신규" 연락처에만 영향)
      const { data: membership } = await admin
        .schema('mailcaster')
        .from('org_members')
        .select('org_id')
        .eq('user_id', userId)
        .order('joined_at', { ascending: true, nullsFirst: false })
        .order('org_id', { ascending: true })
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

    // ── 페이지 단위 저장 (connections / otherContacts 공용) ─────────────
    let inserted = 0
    let duplicates = 0
    let deletedSkipped = 0
    let totalFetched = 0
    let inOtherOrg = 0
    const errors: Array<{ email?: string; message: string }> = []

    const processPage = async (items: PeopleConnection[]): Promise<boolean> => {
      totalFetched += items.length
      // 삭제된 행은 skip (incremental sync 시 metadata.deleted=true 로 옴)
      let pageDeleted = 0
      const rows: NonNullable<ReturnType<typeof connectionToContactRow>>[] = []
      for (const c of items) {
        if (c.metadata?.deleted) {
          pageDeleted++
          continue
        }
        const row = connectionToContactRow(c, userId, orgId)
        if (row) rows.push(row)
      }
      deletedSkipped += pageDeleted

      let ok = true
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const slice = rows.slice(i, i + UPSERT_BATCH)
        const { data, error } = await admin
          .schema('mailcaster')
          .from('contacts')
          .upsert(slice, { onConflict: 'user_id,email', ignoreDuplicates: true })
          .select('id, email')
        if (error) {
          errors.push({ message: error.message })
          ok = false
          continue
        }
        const insertedCount = (data ?? []).length
        inserted += insertedCount
        duplicates += slice.length - insertedCount
      }

      // 진단 — 같은 이메일이 이 사용자의 "다른 조직" 에 존재하는 수.
      // 과거 org 선택 버그로 잘못된 조직에 들어간 연락처를 찾아내기 위한 지표.
      // 비용 절감: 지금까지 신규 삽입이 0 인데 가져온 행이 있을 때만 (의심 상황에서만) 조회.
      // cron 경로는 결과를 보는 사람이 없으므로 생략 (nano DB 부하 절감).
      if (!isCron && rows.length > 0 && inserted === 0) {
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
      return ok
    }

    const saveToken = async (column: TokenColumn, value: string): Promise<void> => {
      const { error } = await admin
        .schema('mailcaster')
        .from('profiles')
        .update({ [column]: value })
        .eq('id', userId)
      if (error) console.warn('[sync-google-contacts] checkpoint 저장 실패:', column, error.message)
    }

    // ── 연락처 (connections) ─────────────────────────────────────────
    // force_full 이면 syncToken·체크포인트 무시 → 전체 sync. 그 외엔 incremental / 재개.
    const main = await runPagedSync(accessToken, {
      label: 'People API',
      url: 'https://people.googleapis.com/v1/people/me/connections',
      fieldParam: ['personFields', PERSON_FIELDS],
      itemsKey: 'connections',
      column: 'google_contacts_sync_token',
      stored: (profile.google_contacts_sync_token as string | null) ?? null,
      forceFull: !!body.force_full,
      deadline,
      processPage,
      saveToken,
    })

    if (main.authError) {
      // 정확한 원인 분리 — Google 응답 body 의 error.message / reason / status 로 판정.
      let errBody: { error?: { message?: string; status?: string } } = {}
      try {
        errBody = JSON.parse(main.authError.body)
      } catch {
        errBody = {}
      }
      const msg = errBody.error?.message ?? ''
      const status = errBody.error?.status ?? ''
      const lastErrorDetail = `${main.authError.status} ${status}: ${msg.slice(0, 240)}`
      console.warn('[sync-google-contacts] auth/forbidden:', lastErrorDetail)
      // People API 미활성화 — GCP 콘솔에서 enable 필요
      if (
        /SERVICE_DISABLED|has not been used|disabled/i.test(msg) ||
        status === 'PERMISSION_DENIED' && /API/i.test(msg)
      ) {
        return json({
          api_disabled: true,
          inserted,
          duplicates,
          deleted_skipped: deletedSkipped,
          detail: lastErrorDetail,
          message: 'Google Cloud 콘솔에서 People API 를 활성화해주세요.',
        })
      }
      // 그 외 401/403 은 scope 누락 또는 토큰 무효
      return json({
        scope_missing: true,
        inserted,
        duplicates,
        deleted_skipped: deletedSkipped,
        detail: lastErrorDetail,
        message: 'Google Contacts 권한이 없습니다. 재로그인 필요.',
      })
    }

    // ── 기타 주소록 (Other contacts) — opt-in ─────────────────────
    // Gmail 이 자동 수집한 상대는 connections 에 없음 → otherContacts.list 로 별도 수집.
    // contacts.other.readonly scope 필요 — 미부여 시 other_scope_missing 플래그만 반환
    // (메인 동기화 결과는 정상 처리).
    // 메인이 예산 초과로 멈췄으면 건너뜀 — 다음 실행에서 메인 완료 후 진행.
    let otherScopeMissing = false
    let otherPartial = false
    const includeOther = profile.google_contacts_include_other === true
    if (includeOther && main.completed) {
      // 전체를 try 로 격리 — otherContacts 의 어떤 실패(5xx/네트워크)도
      // 이미 저장한 메인 connections 동기화를 무산시키지 않는다.
      try {
        const other = await runPagedSync(accessToken, {
          label: 'People otherContacts',
          url: 'https://people.googleapis.com/v1/otherContacts',
          fieldParam: ['readMask', OTHER_READ_MASK],
          itemsKey: 'otherContacts',
          column: 'google_contacts_other_sync_token',
          stored: (profile.google_contacts_other_sync_token as string | null) ?? null,
          forceFull: !!body.force_full,
          deadline,
          processPage,
          saveToken,
        })
        if (other.authError) {
          // scope 누락과 일시적 인증 오류 구분 — scope 계열 메시지일 때만 재로그인 안내
          const bodyText = other.authError.body
          if (/insufficient|scope|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(bodyText)) {
            otherScopeMissing = true
            console.warn('[sync-google-contacts] otherContacts scope missing')
          } else {
            console.warn(
              '[sync-google-contacts] otherContacts auth transient:',
              other.authError.status,
              bodyText.slice(0, 150),
            )
          }
        }
        otherPartial = other.outOfBudget
      } catch (e) {
        // 실패해도 메인 동기화는 계속 — 마지막 체크포인트/토큰부터 다음 실행에서 재시도됨
        console.warn(
          '[sync-google-contacts] otherContacts sync failed (main sync unaffected):',
          e instanceof Error ? e.message : e,
        )
      }
    } else if (includeOther) {
      otherPartial = true
    }

    // 마지막 동기화 시각 (UI 표시용). sync token / 체크포인트는 페이지마다 이미 저장됨.
    // 배치 upsert 오류가 있던 페이지부터는 체크포인트를 진행하지 않으므로
    // 다음 실행이 실패 지점부터 다시 수집한다 (ignoreDuplicates 라 재처리는 무해).
    await admin
      .schema('mailcaster')
      .from('profiles')
      .update({ google_contacts_last_sync_at: new Date().toISOString() })
      .eq('id', userId)

    const partial = main.outOfBudget || otherPartial
    if (partial) {
      console.warn(
        '[sync-google-contacts] 실행 예산 초과 — 체크포인트 저장 후 중간 종료 (다음 실행에서 재개)',
        { userId, fetched: totalFetched, inserted },
      )
    }

    return json({
      inserted,
      duplicates,
      deleted_skipped: deletedSkipped,
      total_fetched: totalFetched,
      in_other_org: inserted === 0 ? inOtherOrg : 0,
      other_scope_missing: otherScopeMissing,
      errors,
      sync_token_updated: main.syncTokenSaved,
      resumed: main.resumed,
      partial,
      ...(partial
        ? { message: '연락처가 많아 일부만 동기화했습니다. 다음 동기화에서 이어서 진행합니다.' }
        : {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// 페이지네이션 + 체크포인트
// ─────────────────────────────────────────────────────────────────────────────

// 저장된 컬럼 값 → { base: incremental 기준 syncToken, resumePage: 재개할 pageToken }
function parseStoredToken(stored: string | null): { base: string | null; resumePage: string | null } {
  if (!stored) return { base: null, resumePage: null }
  if (!stored.startsWith(CHECKPOINT_PREFIX)) return { base: stored, resumePage: null }
  try {
    const cp = JSON.parse(stored.slice(CHECKPOINT_PREFIX.length)) as { page?: unknown; base?: unknown }
    if (typeof cp.page === 'string' && cp.page) {
      return {
        base: typeof cp.base === 'string' && cp.base ? cp.base : null,
        resumePage: cp.page,
      }
    }
  } catch {
    // 손상된 체크포인트 — 아래에서 full sync 로 처리
  }
  console.warn('[sync-google-contacts] 체크포인트 파싱 실패 — full sync 로 진행')
  return { base: null, resumePage: null }
}

function encodeCheckpoint(page: string, base: string | null): string {
  return CHECKPOINT_PREFIX + JSON.stringify({ v: 1, page, base })
}

// People API 목록 엔드포인트를 페이지 단위로 수집 → processPage 로 즉시 저장.
// 페이지 저장 성공 시마다 체크포인트(다음 pageToken)를 기록하고, 마지막 페이지에서
// nextSyncToken 을 기록한다. 예산 초과 시 다음 페이지를 요청하지 않고 반환.
// 401/403 은 authError 로 반환 (호출자가 원인 분류), 그 외 오류는 throw.
async function runPagedSync(accessToken: string, o: PagedSyncOptions): Promise<PagedSyncOutcome> {
  const parsed = o.forceFull ? { base: null, resumePage: null } : parseStoredToken(o.stored)
  const base = parsed.base
  let useSyncToken = !!base
  let pageToken: string | undefined = parsed.resumePage ?? undefined
  let resuming = !!parsed.resumePage
  const resumed = resuming
  let syncTokenRetried = false
  // 한 페이지라도 저장 실패하면 그 뒤로는 체크포인트/토큰을 진행하지 않는다.
  // 저장하면 다음 실행이 실패 페이지를 건너뛰어 해당 연락처가 force_full 전까지 영구 누락됨.
  let writeFailed = false

  const outcome = (p: Partial<PagedSyncOutcome>): PagedSyncOutcome => ({
    completed: false,
    outOfBudget: false,
    authError: null,
    syncTokenSaved: false,
    resumed,
    ...p,
  })

  if (resuming) console.log(`[sync-google-contacts] ${o.label}: 체크포인트에서 재개`)

  // 주의: do…while(pageToken) 구조에서 continue 는 조건 검사로 점프해
  // pageToken=undefined 인 재시도가 루프를 그냥 종료시킨다 — while(true) + 명시 break 사용.
  while (true) {
    if (Date.now() >= o.deadline) return outcome({ outOfBudget: true })

    const params = new URLSearchParams({
      [o.fieldParam[0]]: o.fieldParam[1],
      pageSize: '1000',
      requestSyncToken: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    else if (useSyncToken && base) params.set('syncToken', base)

    const res = await fetchTextWithTimeout(
      `${o.url}?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      FETCH_TIMEOUT_MS,
      o.label,
    )
    if (res.status === 401 || res.status === 403) {
      return outcome({ authError: { status: res.status, body: res.text } })
    }
    // syncToken 만료 — People API 는 400 FAILED_PRECONDITION (EXPIRED_SYNC_TOKEN) 을
    // 반환한다 (410 은 다른 Google API 계열의 관례 — 방어적으로 둘 다 처리).
    // 서버에서 즉시 full sync 로 전환해 재시도 — 클라이언트 왕복 없이 한 번에 처리.
    if (res.status === 410 || res.status === 400) {
      if (resuming) {
        // 이전 실행의 pageToken 이 만료/무효 — base 기준으로 처음부터 다시 수집
        // (이미 저장된 연락처는 ignoreDuplicates 로 건너뛰므로 재처리는 무해).
        console.warn(`[sync-google-contacts] ${o.label}: 체크포인트 만료 — 처음부터 다시 수집`)
        resuming = false
        pageToken = undefined
        continue
      }
      const isExpiredToken =
        res.status === 410 || /EXPIRED_SYNC_TOKEN|Sync token is expired/i.test(res.text)
      if (isExpiredToken && useSyncToken && !syncTokenRetried) {
        console.warn(`[sync-google-contacts] ${o.label}: sync token expired — full sync 으로 전환`)
        syncTokenRetried = true
        useSyncToken = false
        pageToken = undefined
        continue
      }
      throw new Error(`${o.label} ${res.status}: ${res.text.slice(0, 300)}`)
    }
    if (!res.ok) {
      throw new Error(`${o.label} ${res.status}: ${res.text.slice(0, 300)}`)
    }
    resuming = false

    let data: { nextPageToken?: string; nextSyncToken?: string; [k: string]: unknown }
    try {
      data = JSON.parse(res.text)
    } catch {
      throw new Error(`${o.label} 응답 JSON 파싱 실패`)
    }
    const items = Array.isArray(data[o.itemsKey]) ? (data[o.itemsKey] as PeopleConnection[]) : []
    const ok = await o.processPage(items)
    if (!ok) writeFailed = true

    const next = data.nextPageToken
    if (next) {
      // 진행 상태 저장 — 강제 종료돼도 다음 실행이 여기서 이어서 진행.
      // 체크포인트의 base 는 현재 수집의 기준 (full sync 로 전환됐으면 null).
      if (!writeFailed) await o.saveToken(o.column, encodeCheckpoint(next, useSyncToken ? base : null))
      pageToken = next
      continue
    }

    // 마지막 페이지 — nextSyncToken 저장 (체크포인트 대체)
    let syncTokenSaved = false
    if (!writeFailed && data.nextSyncToken) {
      await o.saveToken(o.column, data.nextSyncToken)
      syncTokenSaved = true
    }
    return outcome({ completed: true, syncTokenSaved })
  }
}

// fetch + 본문 읽기까지 타임아웃 적용 — 응답 헤더 이후 본문 수신이 멈춰도 abort.
async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return { status: res.status, ok: res.ok, text }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`${label} 호출 타임아웃 (${Math.round(timeoutMs / 1000)}초 초과)`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
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
  const res = await fetchTextWithTimeout(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    },
    FETCH_TIMEOUT_MS,
    'Google OAuth',
  )
  if (!res.ok) {
    throw new Error(`Google OAuth ${res.status}: ${res.text.slice(0, 200)}`)
  }
  let j: { access_token?: string } = {}
  try {
    j = JSON.parse(res.text)
  } catch {
    throw new Error('Google OAuth 응답 JSON 파싱 실패')
  }
  if (!j.access_token) throw new Error('no access_token')
  return j.access_token
}
