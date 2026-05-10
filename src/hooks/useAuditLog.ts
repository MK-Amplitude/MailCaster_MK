// audit_log (migration 035) 조회 훅.
// 조직의 최근 변경 활동을 가장 최근부터 가져옴.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'

export type AuditAction = 'insert' | 'update' | 'delete'
export type AuditTargetType =
  | 'campaigns'
  | 'contacts'
  | 'groups'
  | 'signatures'
  | 'templates'

export interface AuditLogRow {
  id: string
  org_id: string
  user_id: string | null
  action: AuditAction
  target_type: AuditTargetType
  target_id: string
  diff: { before?: Record<string, unknown>; after?: Record<string, unknown> } | null
  created_at: string
  // 작성자 정보 (profiles join)
  user_email: string | null
  user_name: string | null
  // 대상 이름 (target_type 별 dynamic — 일단 별도 fetch)
}

const QK = 'audit-log'

interface Filters {
  /** 특정 target 만 — undefined 면 전체 */
  targetType?: AuditTargetType
  /** 특정 row 의 변경 이력 */
  targetId?: string
  /** 페이지 크기 — 기본 50 */
  limit?: number
}

export function useAuditLog(filters: Filters = {}) {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: [QK, currentOrg?.id, filters],
    queryFn: async (): Promise<AuditLogRow[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      let q = sb
        .from('audit_log')
        .select(
          'id, org_id, user_id, action, target_type, target_id, diff, created_at, profiles:user_id(email, display_name)'
        )
        .eq('org_id', currentOrg!.id)
        .order('created_at', { ascending: false })
        .limit(filters.limit ?? 50)
      if (filters.targetType) q = q.eq('target_type', filters.targetType)
      if (filters.targetId) q = q.eq('target_id', filters.targetId)
      const { data, error } = await q
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        id: r.id,
        org_id: r.org_id,
        user_id: r.user_id,
        action: r.action as AuditAction,
        target_type: r.target_type as AuditTargetType,
        target_id: r.target_id,
        diff: r.diff,
        created_at: r.created_at,
        user_email: r.profiles?.email ?? null,
        user_name: r.profiles?.display_name ?? null,
      }))
    },
    enabled: !!currentOrg,
    staleTime: 1000 * 30,
  })
}
