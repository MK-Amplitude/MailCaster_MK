// Supabase Edge Function 'resolve-company' 호출 헬퍼
// fire-and-forget 패턴: 실패하더라도 연락처 저장은 성공해야 함

import { supabase } from './supabase'
import type { QueryClient } from '@tanstack/react-query'

// 개인/범용 메일 도메인 — 회사 식별 힌트로 쓰지 않음. Edge Function 과 동기화.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'naver.com',
  'hanmail.net',
  'daum.net',
  'nate.com',
  'yahoo.com',
  'yahoo.co.kr',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'me.com',
  'kakao.com',
  'protonmail.com',
  'proton.me',
])

function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const parts = email.toString().trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[1]) return null
  const domain = parts[1]
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null
  return domain
}

interface ResolveArgs {
  /** 회사명 (없으면 도메인 단독 모드) */
  rawName?: string | null
  contactId: string
  /** 회사 식별 정확도를 높이기 위한 이메일 도메인 힌트 소스 (optional) */
  email?: string | null
  qc?: QueryClient
  /** 캐시 무시하고 LLM 재호출 — 이전 분석 결과의 parent_group 이 비어있을 때 다시 시도 */
  forceRefresh?: boolean
}

/** Edge function 응답 결과 — UI 가 confidence 등 활용 가능 */
export interface ResolveResult {
  name_ko: string | null
  name_en: string | null
  parent_group: string | null
  extracted_department: string | null
  confidence: number
  cached: boolean
}

/**
 * Contact 의 회사명/그룹사를 AI 로 추론.
 * - rawName 이 있으면 회사명 + 도메인 힌트로 정확도 ↑
 * - rawName 이 없으면 이메일 도메인 단독으로 추론 (예: enj@thehyundai.com → "현대백화점")
 * - 둘 다 없으면 null 반환 (no-op)
 *
 * 반환값으로 호출자가 confidence / 결과를 UI 에 표시할 수 있음.
 * 실패 시 null 반환 (throw 안 함 — fire-and-forget 패턴).
 */
export async function resolveCompanyForContact({
  rawName,
  contactId,
  email,
  qc,
  forceRefresh,
}: ResolveArgs): Promise<ResolveResult | null> {
  const name = rawName?.trim()
  const emailDomain = extractDomain(email)
  // 회사명도 없고 (개인 메일 아닌) 유효 도메인도 없으면 호출 불가
  if (!name && !emailDomain) return null

  try {
    // 세션 JWT 를 명시 전달 — resolve-company 가 함수 내부에서 사용자 인증 + org 격리 검증.
    // (publishable anon key 는 JWT 형식 아니라 서버 getUser 가 거부)
    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) {
      console.warn('[resolve-company] no session — skip')
      return null
    }
    const { data, error } = await supabase.functions.invoke('resolve-company', {
      body: {
        // raw_name 이 비어있으면 서버가 도메인 단독 모드로 처리
        ...(name ? { raw_name: name } : {}),
        contact_id: contactId,
        ...(emailDomain ? { email_domain: emailDomain } : {}),
        ...(forceRefresh ? { force_refresh: true } : {}),
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (error) {
      console.warn('[resolve-company] invoke failed:', error.message)
      return null
    }
    if (qc) {
      qc.invalidateQueries({ queryKey: ['contacts'] })
    }
    return data as ResolveResult
  } catch (e) {
    console.warn('[resolve-company] unexpected:', e)
    return null
  }
}

// 배치용 — 여러 연락처를 순차 호출 (동시 호출로 rate limit 히트 방지).
// rawName 은 optional — 없으면 도메인 단독 모드로 묶음.
export async function resolveCompaniesBatch(
  items: Array<{ id: string; rawName?: string | null; email?: string | null }>,
  qc?: QueryClient,
  /** true 면 query_key 별 첫 호출을 force_refresh 로 — 과거 null 캐시를 무시하고 재분석.
   *  "빈 그룹사 채우기" 처럼 프롬프트 개선 후 stale null 을 갱신할 때 사용.
   *  키별 첫 1회만 force → 재분석은 unique 회사 수만큼만 과금, 나머지는 새 캐시 재사용. */
  opts?: { forceRefresh?: boolean }
): Promise<void> {
  const unique = new Map<string, typeof items>()
  for (const it of items) {
    // dedupe 키 — server 의 company_cache query_key 와 동일 규칙:
    //   회사명 있으면 회사명(lower/trim), 없으면 이메일 도메인.
    // 둘 다 없으면 건너뜀 (호출 불가).
    const name = it.rawName?.trim().toLowerCase()
    const domain = extractDomain(it.email)
    const key = name || domain
    if (!key) continue
    const arr = unique.get(key) ?? []
    arr.push(it)
    unique.set(key, arr)
  }

  // query_key 별로 순차 호출 — 첫 호출(도메인 힌트 있는 쪽 우선)이 서버 company_cache 를
  // 채우고, 이후 호출은 서버 캐시 히트로 AI 호출 없이 contact 만 업데이트된다.
  for (const [, group] of unique) {
    const sorted = [...group].sort((a, b) => {
      const da = extractDomain(a.email) ? 1 : 0
      const db = extractDomain(b.email) ? 1 : 0
      return db - da
    })
    for (let i = 0; i < sorted.length; i++) {
      await resolveCompanyForContact({
        rawName: sorted[i].rawName,
        contactId: sorted[i].id,
        email: sorted[i].email,
        // 첫 호출만 force — 재분석 후 캐시가 갱신되므로 나머지는 그 캐시를 재사용
        forceRefresh: i === 0 ? opts?.forceRefresh : false,
      })
    }
  }

  if (qc) qc.invalidateQueries({ queryKey: ['contacts'] })
}
