import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'

// ============================================================
// useUnsubscribes — 전역 수신거부 리스트 관리
// ------------------------------------------------------------
// DB:
//   - mailcaster.unsubscribes — (user_id, email) UNIQUE
//   - mailcaster.contacts.is_unsubscribed / unsubscribed_at — 연관 플래그
//
// 정합성:
//   이 두 곳은 원래 엣지 함수(recipient unsubscribe 페이지) 에서 같이
//   갱신되지만, 이 훅은 사용자가 UI 에서 수동으로 추가/해제할 때의
//   경로이므로 양쪽을 같이 업데이트한다.
//
//   - 추가: unsubscribes insert → contacts.is_unsubscribed=true
//   - 해제: unsubscribes delete → contacts.is_unsubscribed=false
//
//   contacts 에 해당 email 이 없으면 update 는 0 rows 에 영향 → 무해.
// ============================================================

const QK = 'unsubscribes'

export interface Unsubscribe {
  id: string
  user_id: string
  email: string
  reason: string | null
  source_campaign_id: string | null
  unsubscribed_at: string
}

export function useUnsubscribes() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('unsubscribes')
        .select('*')
        .eq('user_id', user!.id)
        .order('unsubscribed_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Unsubscribe[]
    },
    enabled: !!user,
  })
}

export function useCreateUnsubscribe() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ email, reason }: { email: string; reason?: string }) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail) throw new Error('이메일을 입력해주세요.')
      // 간단한 이메일 형식 검증 — 완벽한 RFC 검증이 아니라 "@" 기준 최소 검증
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        throw new Error('올바른 이메일 형식이 아닙니다.')
      }

      // 1) unsubscribes upsert — 중복 email 은 reason 만 업데이트
      const { error: upErr } = await supabase.from('unsubscribes').upsert(
        {
          user_id: user.id,
          email: normalizedEmail,
          reason: reason?.trim() || null,
        },
        { onConflict: 'user_id,email' },
      )
      if (upErr) throw upErr

      // 2) contacts 동기화 — email 매치되는 row 만 갱신
      const { error: cErr } = await supabase
        .from('contacts')
        .update({
          is_unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)
        .eq('email', normalizedEmail)
      if (cErr) {
        // 연락처 업데이트 실패는 비치명 — unsubscribe 자체는 성공했으므로 경고만
        console.warn('[unsubscribe] contacts sync failed:', cErr)
      }

      return normalizedEmail
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success('수신거부 목록에 추가되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[createUnsubscribe] failed:', e)
      toast.error(e.message || '추가 실패')
    },
  })
}

export function useDeleteUnsubscribe() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (unsubscribe: Pick<Unsubscribe, 'id' | 'email'>) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      // 1) unsubscribes 삭제
      const { error } = await supabase
        .from('unsubscribes')
        .delete()
        .eq('id', unsubscribe.id)
      if (error) throw error

      // 2) 같은 email 의 contact 가 있으면 플래그 해제
      const { error: cErr } = await supabase
        .from('contacts')
        .update({ is_unsubscribed: false, unsubscribed_at: null })
        .eq('user_id', user.id)
        .eq('email', unsubscribe.email.toLowerCase())
      if (cErr) {
        console.warn('[unsubscribe delete] contacts sync failed:', cErr)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success('수신거부가 해제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteUnsubscribe] failed:', e)
      toast.error(e.message || '해제 실패')
    },
  })
}

export function useBulkDeleteUnsubscribes() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (items: Pick<Unsubscribe, 'id' | 'email'>[]) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (items.length === 0) return
      const ids = items.map((i) => i.id)
      const emails = items.map((i) => i.email.toLowerCase())

      const { error } = await supabase.from('unsubscribes').delete().in('id', ids)
      if (error) throw error

      // 해당 email 들의 contact 플래그 일괄 해제
      const { error: cErr } = await supabase
        .from('contacts')
        .update({ is_unsubscribed: false, unsubscribed_at: null })
        .eq('user_id', user.id)
        .in('email', emails)
      if (cErr) {
        console.warn('[unsubscribe bulk delete] contacts sync failed:', cErr)
      }
    },
    onSuccess: (_, items) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success(`${items.length}개 수신거부가 해제되었습니다.`)
    },
    onError: (e: Error) => {
      console.error('[bulkDeleteUnsubscribes] failed:', e)
      toast.error(e.message || '일괄 해제 실패')
    },
  })
}
