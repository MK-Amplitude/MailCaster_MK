// Supabase Edge Function: refresh-google-token
// Google OAuth access_token 이 만료됐을 때 refresh_token 으로 갱신
// 호출자 인증 필요 (JWT). 성공 시 profiles 테이블 업데이트 + 새 토큰 반환.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
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
    const jwt = authHeader.slice('Bearer '.length)

    // JWT payload 직접 디코딩 (ES256 지원 위해 Gateway verify_jwt=false)
    // service_role 로 DB 접근하므로 sub(userId) 만 추출해서 사용
    let userId: string
    try {
      const parts = jwt.split('.')
      if (parts.length !== 3) throw new Error('invalid jwt')
      const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
      const payload = JSON.parse(payloadJson)
      if (!payload.sub) throw new Error('sub 없음')
      if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('JWT 만료')
      userId = payload.sub as string
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return json({ error: `JWT 파싱 실패: ${msg}` }, 401)
    }

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

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: profile.google_refresh_token,
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
