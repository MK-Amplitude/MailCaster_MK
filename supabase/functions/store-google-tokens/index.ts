// Supabase Edge Function: store-google-tokens
//
// OAuth 로그인 직후 프론트엔드가 받은 Google provider 토큰을 서버에서 저장.
// 목적: 장기 자격증명인 refresh_token 을 프론트가 평문으로 직접 DB 에 쓰던 경로를 제거하고
//       서버에서 AES-256-GCM 으로 암호화해 저장 (TOKEN_ENCRYPTION_KEY 설정 시).
//
// - access_token: 평문 저장 — 프론트 캐시 (googleToken.ts) 가 이 컬럼을 그대로 사용. 1시간 수명.
// - refresh_token: encryptToken() 으로 암호화 저장. 읽는 쪽 (각 cron/Edge Function) 은
//   decryptToken() 을 이미 통과시키므로 암호화/평문 모두 호환.
//
// 입력: { access_token?: string, refresh_token?: string }
// 인증: 사용자 JWT (ES256 이므로 gateway verify_jwt=false + 함수 내 auth.getUser())

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { encryptToken } from '../_shared/tokenCrypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

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
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '인증 필요' }, 401)

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await authClient.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json({ error: '유효하지 않은 세션입니다.' }, 401)
    }
    const userId = userData.user.id

    let body: { access_token?: string; refresh_token?: string } = {}
    try {
      body = await req.json()
    } catch {
      return json({ error: '요청 본문을 읽을 수 없습니다.' }, 400)
    }

    const accessToken =
      typeof body.access_token === 'string' && body.access_token.length > 0 && body.access_token.length < 4096
        ? body.access_token
        : null
    const refreshToken =
      typeof body.refresh_token === 'string' && body.refresh_token.length > 0 && body.refresh_token.length < 4096
        ? body.refresh_token
        : null
    if (!accessToken && !refreshToken) {
      return json({ error: '저장할 토큰이 없습니다.' }, 400)
    }

    const updates: Record<string, unknown> = {}
    if (accessToken) {
      updates.google_access_token = accessToken
      // Google OAuth 스펙상 access_token 유효기간 1시간
      updates.token_expires_at = new Date(Date.now() + 3600_000).toISOString()
    }
    if (refreshToken) {
      updates.google_refresh_token = await encryptToken(refreshToken)
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const { error: upErr } = await admin
      .schema('mailcaster')
      .from('profiles')
      .update(updates)
      .eq('id', userId)
    if (upErr) {
      console.error('[store-google-tokens] update failed:', upErr)
      return json({ error: '토큰 저장에 실패했습니다.' }, 500)
    }

    return json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[store-google-tokens] fatal:', msg)
    return json({ error: msg }, 500)
  }
})
