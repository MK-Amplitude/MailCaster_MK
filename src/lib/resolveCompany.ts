// Supabase Edge Function 'resolve-company' 호출 헬퍼
// fire-and-forget 패턴: 실패하더라도 연락처 저장은 성공해야 함

import { supabase } from './supabase'
import type { QueryClient } from '@tanstack/react-query'

interface ResolveArgs {
  rawName: string
  contactId: string
  qc?: QueryClient
}

export async function resolveCompanyForContact({
  rawName,
  contactId,
  qc,
}: ResolveArgs): Promise<void> {
  const name = rawName?.trim()
  if (!name) return

  try {
    const { data, error } = await supabase.functions.invoke('resolve-company', {
      body: { raw_name: name, contact_id: contactId },
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
  items: Array<{ id: string; rawName: string }>,
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

  // query_key 별로 하나만 실제 호출 (나머지는 캐시 이용)
  for (const [, group] of unique) {
    // 첫 항목은 AI 호출 + contact 업데이트까지 수행
    await resolveCompanyForContact({
      rawName: group[0].rawName,
      contactId: group[0].id,
    })
    // 나머지는 캐시에서 꺼내 contact 별 업데이트만 수행
    for (let i = 1; i < group.length; i++) {
      await resolveCompanyForContact({
        rawName: group[i].rawName,
        contactId: group[i].id,
      })
    }
  }

  if (qc) qc.invalidateQueries({ queryKey: ['contacts'] })
}
