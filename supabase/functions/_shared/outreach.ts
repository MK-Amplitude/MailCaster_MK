// Outreach REST API 헬퍼 — OAuth token refresh + API 호출 공통 로직.
//
// Outreach API v2:
//   - Base: https://api.outreach.io/api/v2
//   - JSON:API 스펙 (data: { type, attributes, relationships })
//   - Rate limit: 60 req/min (X-RateLimit-Remaining 헤더로 확인)
//
// OAuth:
//   - Auth URL:  https://accounts.outreach.io/oauth/authorize
//   - Token URL: https://accounts.outreach.io/oauth/token
//   - Access token 수명 ≈ 2 시간. Refresh token 영속.

const OUTREACH_API_BASE = 'https://api.outreach.io/api/v2'
const OUTREACH_TOKEN_URL = 'https://accounts.outreach.io/oauth/token'

export interface OutreachTokens {
  access_token: string
  refresh_token: string
  expires_at: string // ISO
  user_id?: number
}

export async function exchangeCodeForTokens(params: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(OUTREACH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code: params.code,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach token exchange failed ${res.status}: ${body.slice(0, 300)}`)
  }
  return await res.json()
}

export async function refreshOutreachToken(params: {
  clientId: string
  clientSecret: string
  refreshToken: string
  redirectUri: string
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(OUTREACH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach token refresh failed ${res.status}: ${body.slice(0, 300)}`)
  }
  return await res.json()
}

// 현재 사용자 정보 — connection 검증 및 user_id 캐시 용.
export async function getOutreachCurrentUser(accessToken: string): Promise<{
  id: number
  email: string
  firstName?: string
  lastName?: string
}> {
  const res = await fetch(`${OUTREACH_API_BASE}/users?filter[email]=me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach get-user failed ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const user = data.data?.[0]
  if (!user) throw new Error('Outreach 사용자 정보를 찾을 수 없습니다.')
  return {
    id: user.id,
    email: user.attributes?.email ?? '',
    firstName: user.attributes?.firstName,
    lastName: user.attributes?.lastName,
  }
}

// Prospect lookup by email — 없으면 null. 정확히 동일 email 매칭.
export async function findProspectByEmail(
  accessToken: string,
  email: string,
): Promise<{ id: number } | null> {
  const url = `${OUTREACH_API_BASE}/prospects?filter[emails]=${encodeURIComponent(email)}&page[size]=1`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach prospect lookup failed ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const p = data.data?.[0]
  return p ? { id: p.id } : null
}

// Prospect 생성 — email 만 필수. 이름/회사 등은 선택.
export async function createProspect(
  accessToken: string,
  params: {
    email: string
    firstName?: string | null
    lastName?: string | null
    company?: string | null
    title?: string | null
  },
): Promise<{ id: number }> {
  const attributes: Record<string, unknown> = {
    emails: [params.email],
  }
  if (params.firstName) attributes.firstName = params.firstName
  if (params.lastName) attributes.lastName = params.lastName
  if (params.company) attributes.company = params.company
  if (params.title) attributes.title = params.title

  const res = await fetch(`${OUTREACH_API_BASE}/prospects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    body: JSON.stringify({ data: { type: 'prospect', attributes } }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach prospect create failed ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return { id: data.data.id }
}

// Mailing record 생성 — prospect 의 activity timeline 에 노출.
//   state: 'delivered' — 이미 발송된 메일 (MailCaster 가 Gmail 로 보냄)
//   direction: 'outbound'
export async function createMailing(
  accessToken: string,
  params: {
    prospectId: number
    subject: string
    bodyHtml: string
    sentAt: string // ISO
  },
): Promise<{ id: number }> {
  const res = await fetch(`${OUTREACH_API_BASE}/mailings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'mailing',
        attributes: {
          subject: params.subject,
          bodyHtml: params.bodyHtml,
          state: 'delivered',
          deliveredAt: params.sentAt,
        },
        relationships: {
          prospect: {
            data: { type: 'prospect', id: params.prospectId },
          },
        },
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Outreach mailing create failed ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return { id: data.data.id }
}

// 토큰 만료 임박 (10분 이내) 여부.
export function isTokenExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const expiry = new Date(expiresAt).getTime()
  return Date.now() + 10 * 60 * 1000 >= expiry
}

export function computeExpiresAt(expiresInSec: number): string {
  return new Date(Date.now() + expiresInSec * 1000).toISOString()
}
