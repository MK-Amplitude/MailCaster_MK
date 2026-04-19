import { supabase } from './supabase'

interface RefreshResponse {
  access_token: string
  expires_at: string
}

async function refreshViaEdge(): Promise<string> {
  const { data, error } = await supabase.functions.invoke<RefreshResponse>(
    'refresh-google-token',
    { body: {} }
  )
  if (error) {
    console.error('[googleToken] refresh invoke failed:', error)
    throw new Error(
      '토큰 갱신 실패 — 로그아웃 후 다시 로그인해주세요. (' + error.message + ')'
    )
  }
  if (!data?.access_token) throw new Error('토큰 응답이 비어있습니다.')
  return data.access_token
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
 * 2) 만료됐거나 없으면 refresh Edge Function 호출
 */
export async function getFreshGoogleToken(userId: string): Promise<string> {
  const SAFETY_MARGIN_MS = 60_000 // 만료 1분 전에도 갱신

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
    if (expiresMs - Date.now() > SAFETY_MARGIN_MS) {
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
