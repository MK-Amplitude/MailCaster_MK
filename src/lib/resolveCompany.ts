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
  rawName: string
  contactId: string
  /** 회사 식별 정확도를 높이기 위한 이메일 도메인 힌트 소스 (optional) */
  email?: string | null
  qc?: QueryClient
}

export async function resolveCompanyForContact({
  rawName,
  contactId,
  email,
  qc,
}: ResolveArgs): Promise<void> {
  const name = rawName?.trim()
  if (!name) return

  const emailDomain = extractDomain(email)

  try {
    const { data, error } = await supabase.functions.invoke('resolve-company', {
      body: {
        raw_name: name,
        contact_id: contactId,
        // 클라이언트에서 도메인을 알면 서버 DB 조회를 아끼고, 모르면 서버가 fallback 처리.
        ...(emailDomain ? { email_domain: emailDomain } : {}),
      },
    })
    if (error) {
      console.warn('[resolve-company] invoke failed:', error.message)
      return
    }
    console.log('[resolve-company] result:', data)
    if (qc) {
      qc.invalidateQueries({ queryKey: ['contacts'] })
    }
  } catch (e) {
    console.warn('[resolve-company] unexpected:', e)
  }
}

// 배치용 — 여러 연락처를 순차 호출 (동시 호출로 rate limit 히트 방지)
export async function resolveCompaniesBatch(
  items: Array<{ id: string; rawName: string; email?: string | null }>,
  qc?: QueryClient
): Promise<void> {
  const unique = new Map<string, typeof items>()
  for (const it of items) {
    const key = it.rawName.trim().toLowerCase()
    if (!key) continue
    const arr = unique.get(key) ?? []
    arr.push(it)
    unique.set(key, arr)
  }

  // query_key 별로 하나만 실제 호출 (나머지는 캐시 이용).
  // 대표 샘플은 "도메인 힌트가 있는" 항목을 우선 선택 — AI 정확도가 높아짐.
  for (const [, group] of unique) {
    const sorted = [...group].sort((a, b) => {
      const da = extractDomain(a.email) ? 1 : 0
      const db = extractDomain(b.email) ? 1 : 0
      return db - da
    })
    // 첫 항목(=도메인 있는 쪽)은 AI 호출 + contact 업데이트까지 수행
    await resolveCompanyForContact({
      rawName: sorted[0].rawName,
      contactId: sorted[0].id,
      email: sorted[0].email,
    })
    // 나머지는 캐시에서 꺼내 contact 별 업데이트만 수행
    for (let i = 1; i < sorted.length; i++) {
      await resolveCompanyForContact({
        rawName: sorted[i].rawName,
        contactId: sorted[i].id,
        email: sorted[i].email,
      })
    }
  }

  if (qc) qc.invalidateQueries({ queryKey: ['contacts'] })
}
