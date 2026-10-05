import { supabase } from './supabase'

interface RefreshResponse {
  access_token: string
  expires_at: string
}

// 일시적 실패(5xx / 네트워크 / relay / cold start)만 재시도. 401·400 은 refresh_token 폐기 등
// 재로그인이 필요한 영구 오류라 재시도해도 소용없다.
const REFRESH_MAX_ATTEMPTS = 3
const REFRESH_BACKOFF_BASE_MS = 1000

type RefreshError = Error & { status?: number; authFailure?: boolean }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function refreshViaEdgeOnce(): Promise<string> {
  const { data, error } = await supabase.functions.invoke<RefreshResponse>(
    'refresh-google-token',
    { body: {} }
  )
  if (error) {
    console.error('[googleToken] refresh invoke failed:', error)
    // FunctionsHttpError 의 context 는 Response — 함수가 돌려준 HTTP status.
    const ctx = (error as { context?: unknown }).context
    const httpStatus = ctx instanceof Response ? ctx.status : undefined
    const authFailure = httpStatus === 400 || httpStatus === 401 || httpStatus === 403
    const err = new Error(
      authFailure
        ? '토큰 갱신 실패 — 로그아웃 후 다시 로그인해주세요. (' + error.message + ')'
        : '토큰 갱신 서버 일시 오류 — 잠시 후 다시 시도해주세요. (' + error.message + ')'
    ) as RefreshError
    err.status = httpStatus
    err.authFailure = authFailure
    throw err
  }
  if (!data?.access_token) throw new Error('토큰 응답이 비어있습니다.')
  return data.access_token
}

// 동시 refresh 단일화 — 캠페인 발송 루프·Drive 호출·스레드 발송이 같은 탭에서 동시에 401 을
// 받으면 refresh 를 여러 번 부르게 되고, Google 이 refresh_token 회전 시 앞선 응답의 토큰을
// 무효화할 수 있다. 진행 중인 refresh 가 있으면 그 결과를 함께 기다린다.
let inflightRefresh: Promise<string> | null = null

function refreshViaEdge(): Promise<string> {
  if (!inflightRefresh) {
    inflightRefresh = refreshViaEdgeWithRetry().finally(() => {
      inflightRefresh = null
    })
  }
  return inflightRefresh
}

async function refreshViaEdgeWithRetry(): Promise<string> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
    try {
      return await refreshViaEdgeOnce()
    } catch (e) {
      lastErr = e
      if ((e as RefreshError).authFailure || attempt >= REFRESH_MAX_ATTEMPTS) break
      const delay = REFRESH_BACKOFF_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 250
      console.warn(
        `[googleToken] refresh attempt ${attempt}/${REFRESH_MAX_ATTEMPTS} failed — retry in ${Math.round(delay)}ms`
      )
      await sleep(delay)
    }
  }
  throw lastErr
}

/**
 * 유효한 Google access_token 을 반환.
 *
 * 주의: supabase 의 `session.expires_at` 은 Supabase JWT 만료(1hr)이고
 * Google access_token 만료와는 별개 타임라인이다 (Supabase 가 세션을 refresh 해도
 * provider_token 은 갱신되지 않음). 그래서 Google 토큰 유효성 판단은 오직
 * profiles.token_expires_at (Edge Function 이 OAuth 응답의 expires_in 을 기준으로 저장) 만
 * 신뢰한다.
 *
 * 1) profiles 의 google_access_token + token_expires_at 확인 — 유효하면 그대로 반환
 * 2) 만료됐거나 없으면 refresh Edge Function 호출 (일시 오류는 최대 3회 backoff 재시도)
 *
 * minValidityMs: 남은 유효시간이 이보다 짧으면 미리 갱신 (긴 발송 루프에서 선제 갱신용).
 */
export async function getFreshGoogleToken(
  userId: string,
  minValidityMs = 60_000,
): Promise<string> {
  // S9: .maybeSingle() — profiles row 가 아직 생성되지 않았거나 (신규 가입 직후 edge case),
  //     RLS 로 visibility 가 없는 경우에도 null 로 수신하고 refresh 경로로 fall-through.
  //     (.single() 은 0 rows 일 때 error 를 던져서 재시도조차 못 함)
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('google_access_token, token_expires_at')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    console.warn('[googleToken] profile lookup failed, fall back to refresh:', error.message)
  }

  if (profile?.google_access_token && profile.token_expires_at) {
    const expiresMs = new Date(profile.token_expires_at).getTime()
    if (expiresMs - Date.now() > minValidityMs) {
      return profile.google_access_token
    }
  }

  console.log('[googleToken] refreshing via edge function')
  return await refreshViaEdge()
}

/** 401 재시도 용 — 캐시 무시하고 무조건 refresh */
export async function forceRefreshGoogleToken(): Promise<string> {
  return await refreshViaEdge()
}
