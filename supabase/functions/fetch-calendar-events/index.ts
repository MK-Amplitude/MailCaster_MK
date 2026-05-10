// Supabase Edge Function: fetch-calendar-events
//
// 연락처 한 명의 이메일이 attendee 로 포함된 Google Calendar 이벤트를 시간순 fetch.
// ContactTimeline 에 미팅을 인입하기 위함.
//
// 입력: { contact_email: string, max_results?: number }
// 출력: { events: CalendarEvent[], scope_missing?: boolean }
//
// 인증: 사용자 JWT — google_refresh_token 으로 access_token refresh → Calendar API.
// Scope 필요: https://www.googleapis.com/auth/calendar.readonly
// Scope 미부여 시 (기존 사용자) → scope_missing: true 로 응답, frontend 가 재로그인 안내.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

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

const RequestSchema = z.object({
  contact_email: z.string().email(),
  max_results: z.number().int().min(1).max(100).optional(),
})

interface CalendarEvent {
  id: string
  summary: string | null
  start_at: string | null
  end_at: string | null
  hangout_link: string | null
  html_link: string | null
  attendees_count: number
  organizer_email: string | null
  status: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return json({ error: '로그인이 필요합니다.' }, 401)

    let parsed: z.infer<typeof RequestSchema>
    try {
      parsed = RequestSchema.parse(await req.json())
    } catch (e) {
      const msg =
        e instanceof z.ZodError
          ? e.errors[0]?.message ?? '잘못된 요청'
          : '요청 본문을 읽을 수 없습니다.'
      return json({ error: msg }, 400)
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json({ error: '인증 실패' }, 401)
    const userId = userData.user.id

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    const { data: profile } = await admin
      .schema('mailcaster')
      .from('profiles')
      .select('google_refresh_token')
      .eq('id', userId)
      .single()
    if (!profile?.google_refresh_token) {
      return json({ events: [], scope_missing: true }, 200)
    }

    let accessToken: string
    try {
      accessToken = await refreshGoogleToken(profile.google_refresh_token as string)
    } catch (e) {
      return json({ events: [], scope_missing: true, detail: String(e) }, 200)
    }

    // Calendar API events.list — q 로 attendee email 검색
    // timeMin: 1년 전 이후 이벤트만 (영업 컨텍스트에서 그 이상은 의미 적음)
    const timeMin = new Date(Date.now() - 365 * 86400_000).toISOString()
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
      `?q=${encodeURIComponent(parsed.contact_email)}` +
      `&timeMin=${encodeURIComponent(timeMin)}` +
      `&maxResults=${parsed.max_results ?? 30}` +
      `&orderBy=startTime&singleEvents=true`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      // 403 — scope 미부여
      if (res.status === 403) {
        return json({ events: [], scope_missing: true }, 200)
      }
      const body = await res.text().catch(() => '')
      return json(
        { error: `Calendar API ${res.status}: ${body.slice(0, 200)}`, events: [] },
        500
      )
    }

    const data = (await res.json()) as {
      items?: Array<{
        id: string
        summary?: string
        start?: { dateTime?: string; date?: string }
        end?: { dateTime?: string; date?: string }
        hangoutLink?: string
        htmlLink?: string
        attendees?: Array<{ email?: string }>
        organizer?: { email?: string }
        status?: string
      }>
    }
    const items = data.items ?? []

    // 추가 클라이언트 사이드 필터: 검색 결과에 contact_email 이 attendee 또는 organizer 로
    // 들어있는 이벤트만. (Google q 는 substring match 라 일치도 보장 X)
    const target = parsed.contact_email.toLowerCase()
    const events: CalendarEvent[] = items
      .filter((it) => {
        const attEmails = (it.attendees ?? []).map((a) => (a.email ?? '').toLowerCase())
        const orgEmail = (it.organizer?.email ?? '').toLowerCase()
        return attEmails.includes(target) || orgEmail === target
      })
      .map((it) => ({
        id: it.id,
        summary: it.summary ?? null,
        start_at: it.start?.dateTime ?? it.start?.date ?? null,
        end_at: it.end?.dateTime ?? it.end?.date ?? null,
        hangout_link: it.hangoutLink ?? null,
        html_link: it.htmlLink ?? null,
        attendees_count: (it.attendees ?? []).length,
        organizer_email: it.organizer?.email ?? null,
        status: it.status ?? null,
      }))

    return json({ events })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[calendar] fatal:', msg)
    return json({ error: '서버 오류', detail: msg }, 500)
  }
})

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
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
    throw new Error(`Google OAuth ${res.status}: ${body}`)
  }
  const j = await res.json()
  if (!j.access_token) throw new Error('no access_token')
  return j.access_token as string
}
