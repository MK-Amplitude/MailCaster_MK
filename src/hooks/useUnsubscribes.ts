import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'

// ============================================================
// useUnsubscribes — 조직 단위 수신거부 리스트 관리
// ------------------------------------------------------------
// DB:
//   - mailcaster.unsubscribes — (org_id, email) UNIQUE  [018 이후]
//   - mailcaster.contacts.is_unsubscribed / unsubscribed_at — 연관 플래그
//
// RLS:
//   - SELECT : 조직 전체 (018 unsubscribes_select_org)
//   - INSERT : user_id=auth.uid() AND 내가 속한 조직 (018 unsubscribes_insert_own)
//   - UPDATE/DELETE : 본인 기록 OR org admin (018 ..._own_or_admin)
//
// 정합성 (019 트리거):
//   - unsubscribes INSERT → trg_unsubscribes_sync_contacts 가 같은 org 의 모든
//     contacts.is_unsubscribed=true 를 SECURITY DEFINER 로 일괄 적용 (RLS 바이패스)
//   - unsubscribes DELETE → 같은 방식으로 플래그 해제
//   - contacts BEFORE INSERT → trg_contacts_apply_unsubscribe 가 기존 unsubscribe
//     체크 후 자동으로 is_unsubscribed=true 설정
//
//   따라서 이 훅은 unsubscribes 테이블에만 쓰면 되고, contacts 동기화는
//   DB 가 책임진다 — 프런트/엣지 함수 경로 모두 일관됨.
//
// scope:
//   'mine' — 내가 등록한 것만 (user_id=me)
//   'org'  — 조직 전체 (RLS 가 필터 — 추가 WHERE 불필요)
// ============================================================

const QK = 'unsubscribes'

export type UnsubscribeScope = 'mine' | 'org'

export interface Unsubscribe {
  id: string
  user_id: string
  org_id: string
  email: string
  reason: string | null
  source_campaign_id: string | null
  unsubscribed_at: string
}

// 조직 멤버 표시용 확장 row — 등록자 이름/이메일 조인
export interface UnsubscribeWithOwner extends Unsubscribe {
  profiles: { display_name: string | null; email: string | null } | null
}

export function useUnsubscribes(scope: UnsubscribeScope = 'org') {
  const { user, currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id, scope, user?.id],
    queryFn: async (): Promise<UnsubscribeWithOwner[]> => {
      let q = supabase
        .from('unsubscribes')
        // profiles 조인으로 등록자 표시 — 조직 공유 시 누가 등록했는지 보여야 함
        .select('*, profiles(display_name, email)')
        .eq('org_id', currentOrg!.id)
        .order('unsubscribed_at', { ascending: false })

      if (scope === 'mine') {
        q = q.eq('user_id', user!.id)
      }

      const { data, error } = await q
      if (error) throw error
      return (data ?? []) as unknown as UnsubscribeWithOwner[]
    },
    enabled: !!user && !!currentOrg,
  })
}

export function useCreateUnsubscribe() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ email, reason }: { email: string; reason?: string }) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('조직이 선택되지 않았습니다.')
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail) throw new Error('이메일을 입력해주세요.')
      // 간단한 이메일 형식 검증 — 완벽한 RFC 검증이 아니라 "@" 기준 최소 검증
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('올바른 이메일 형식이 아닙니다.')
      }

      // unsubscribes upsert — 중복 email 은 reason/등록자만 업데이트.
      // onConflict: org_id,email — 조직 내 한 번만 등록 가능 (누가 등록했든 합침).
      // contacts 동기화는 019 트리거가 처리하므로 별도 UPDATE 불필요.
      const { error: upErr } = await supabase.from('unsubscribes').upsert(
        {
          user_id: user.id,
          org_id: currentOrg.id,
          email: normalizedEmail,
          reason: reason?.trim() || null,
        },
        { onConflict: 'org_id,email' },
      )
      if (upErr) throw upErr

      return normalizedEmail
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      // 트리거가 contacts 를 업데이트하므로 캐시도 invalidate
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      toast.success('수신거부 목록에 추가되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[createUnsubscribe] failed:', e)
      toast.error(e.message || '추가 실패')
    },
  })
}

export function useDeleteUnsubscribe() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (unsubscribe: Pick<Unsubscribe, 'id'>) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('조직이 선택되지 않았습니다.')
      // unsubscribes DELETE — RLS 가 own_or_admin 필터.
      // 019 트리거가 같은 org 의 contacts 플래그를 자동으로 해제.
      const { error } = await supabase
        .from('unsubscribes')
        .delete()
        .eq('id', unsubscribe.id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      toast.success('수신거부가 해제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteUnsubscribe] failed:', e)
      toast.error(e.message || '해제 실패')
    },
  })
}

export function useBulkDeleteUnsubscribes() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (items: Pick<Unsubscribe, 'id'>[]) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('조직이 선택되지 않았습니다.')
      if (items.length === 0) return
      const ids = items.map((i) => i.id)

      // RLS 가 own_or_admin 이라 다른 멤버의 등록 row 는 조용히 필터됨.
      // UI 에서 선택 가능한 건 canMutate 로 미리 거르므로 일반적으로 안전.
      // 019 트리거가 FOR EACH ROW 로 같은 org 의 contacts 플래그를 일괄 해제.
      const { error } = await supabase.from('unsubscribes').delete().in('id', ids)
      if (error) throw error
    },
    onSuccess: (_, items) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['contacts-common'] })
      toast.success(`${items.length}개 수신거부가 해제되었습니다.`)
    },
    onError: (e: Error) => {
      console.error('[bulkDeleteUnsubscribes] failed:', e)
      toast.error(e.message || '일괄 해제 실패')
    },
  })
}
