// Supabase Edge Function: refresh-google-token
// Google OAuth access_token 이 만료됐을 때 refresh_token 으로 갱신
// 호출자 인증 필요 (JWT). 성공 시 profiles 테이블 업데이트 + 새 토큰 반환.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decryptToken } from '../_shared/tokenCrypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: '인증 필요' }, 401)
    }

    // auth.getUser() 로 JWT 서명까지 검증 — 수동 base64 디코드는 서명을 검증하지 않아
    // 위조 토큰으로 타 사용자의 refresh_token 을 탈취할 수 있는 CRITICAL 취약점이 있었음.
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await authClient.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json({ error: '유효하지 않은 세션입니다.' }, 401)
    }
    const userId = userData.user.id

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    const { data: profile, error: pErr } = await supabase
      .schema('mailcaster')
      .from('profiles')
      .select('google_refresh_token')
      .eq('id', userId)
      .single()
    if (pErr) return json({ error: pErr.message }, 500)
    if (!profile?.google_refresh_token) {
      return json(
        { error: 'refresh_token 없음. 로그아웃 후 다시 로그인하세요.' },
        400
      )
    }

    // 암호화된 refresh_token 복호화 (평문 저장된 기존 토큰은 그대로 통과)
    const refreshToken = await decryptToken(profile.google_refresh_token)

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!tokenRes.ok) {
      const body = await tokenRes.text()
      console.error('[refresh-google-token] google oauth failed:', tokenRes.status, body)
      return json(
        {
          error: `Google OAuth 실패 (${tokenRes.status}). refresh_token 이 폐기되었을 수 있습니다. 재로그인 필요.`,
          detail: body,
        },
        tokenRes.status === 400 || tokenRes.status === 401 ? 401 : 500
      )
    }

    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token as string | undefined
    const expiresIn = Number(tokenData.expires_in) || 3600
    if (!accessToken) return json({ error: 'access_token 미반환' }, 500)

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // access_token 은 평문 저장 — 프론트엔드 캐시 (googleToken.ts) 가 이 컬럼을 그대로
    // Bearer 로 사용하므로 암호화하면 안 됨. 1시간 수명이라 유출 시 피해도 제한적.
    // 장기 자격증명인 refresh_token 만 암호화 대상 (store-google-tokens 에서 처리).
    const { error: upErr } = await supabase
      .schema('mailcaster')
      .from('profiles')
      .update({
        google_access_token: accessToken,
        token_expires_at: expiresAt,
      })
      .eq('id', userId)
    if (upErr) console.error('[refresh-google-token] profile update failed:', upErr)

    return json({ access_token: accessToken, expires_at: expiresAt })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[refresh-google-token] failed:', msg)
    return json({ error: msg }, 500)
  }
})
