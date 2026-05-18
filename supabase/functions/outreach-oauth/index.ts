// Supabase Edge Function: outreach-oauth
//
// Outreach OAuth Authorization Code 흐름 마무리:
//   - 사용자가 Outreach 에서 인증 후 redirect 로 돌아오면 frontend 가 이 함수를 호출.
//   - code 를 access_token + refresh_token 으로 교환 → profiles 에 저장.
//
// 입력: { code: string, redirect_uri: string }  + Bearer <user_jwt>
// 출력: { connected: true, outreach_email?: string }

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  exchangeCodeForTokens,
  getOutreachCurrentUser,
  computeExpiresAt,
} from '../_shared/outreach.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const OUTREACH_CLIENT_ID = Deno.env.get('OUTREACH_CLIENT_ID') ?? ''
const OUTREACH_CLIENT_SECRET = Deno.env.get('OUTREACH_CLIENT_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RequestSchema = z.object({
  code: z.string().min(10),
  redirect_uri: z.string().url(),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    if (!OUTREACH_CLIENT_ID || !OUTREACH_CLIENT_SECRET) {
      return json({ error: 'Outreach OAuth 가 서버에 설정되지 않았습니다. 관리자에게 문의하세요.' }, 500)
    }

    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401)

    let parsed: z.infer<typeof RequestSchema>
    try {
      parsed = RequestSchema.parse(await req.json())
    } catch (e) {
      const msg = e instanceof z.ZodError
        ? e.errors[0]?.message ?? '잘못된 요청'
        : '요청 본문을 읽을 수 없습니다.'
      return json({ error: msg }, 400)
    }

    // 사용자 식별
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json({ error: '인증 실패' }, 401)
    const userId = userData.user.id

    // 1) code → tokens
    const tokens = await exchangeCodeForTokens({
      clientId: OUTREACH_CLIENT_ID,
      clientSecret: OUTREACH_CLIENT_SECRET,
      code: parsed.code,
      redirectUri: parsed.redirect_uri,
    })

    // 2) Outreach 사용자 정보 — user_id 캐시
    let outreachUserId: number | null = null
    let outreachEmail: string | null = null
    try {
      const me = await getOutreachCurrentUser(tokens.access_token)
      outreachUserId = me.id
      outreachEmail = me.email
    } catch (e) {
      console.warn('[outreach-oauth] get current user failed:', e)
      // 사용자 정보 못 가져와도 token 은 유효하므로 진행
    }

    // 3) profile 에 저장
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
    const { error: upErr } = await admin
      .schema('mailcaster')
      .from('profiles')
      .update({
        outreach_access_token: tokens.access_token,
        outreach_refresh_token: tokens.refresh_token,
        outreach_token_expires_at: computeExpiresAt(tokens.expires_in),
        outreach_user_id: outreachUserId,
        outreach_connected_at: new Date().toISOString(),
      })
      .eq('id', userId)
    if (upErr) throw upErr

    return json({ connected: true, outreach_email: outreachEmail })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[outreach-oauth] fatal:', msg)
    return json({ error: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
