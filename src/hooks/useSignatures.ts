import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { SignatureInsert, SignatureUpdate } from '@/types/signature'
import { toast } from 'sonner'

const QK = 'signatures'

// 서명은 개인 정보(이름/직책) 를 포함하므로 기본 범위는 'mine'.
// 'org' 로 주면 팀원의 서명도 볼 수 있음 (참고/카피용).
export type SignatureScope = 'mine' | 'org'

export function useSignatures(scope: SignatureScope = 'mine') {
  const { user, currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id, scope],
    queryFn: async () => {
      let query = supabase
        .from('signatures')
        .select('*, profiles:user_id(email, display_name)')
        .eq('org_id', currentOrg!.id)
        .order('created_at', { ascending: false })

      if (scope === 'mine') {
        query = query.eq('user_id', user!.id)
      }

      const { data, error } = await query
      if (error) throw error
      return data ?? []
    },
    enabled: !!user && !!currentOrg,
  })
}

export function useCreateSignature() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<SignatureInsert, 'user_id' | 'org_id'>) => {
      console.log('[createSignature] start', { data, userId: user?.id, orgId: currentOrg?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      const { data: result, error } = await supabase
        .from('signatures')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ ...data, user_id: user.id, org_id: currentOrg.id } as any)
        .select()
        .single()
      console.log('[createSignature] result', { result, error })
      if (error) throw error
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('서명이 저장되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[createSignature] failed:', e)
      toast.error(e.message || '서명 저장 실패')
    },
  })
}

export function useUpdateSignature() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: SignatureUpdate }) => {
      console.log('[updateSignature] start', { id, data })
      const { error } = await supabase.from('signatures').update(data).eq('id', id)
      console.log('[updateSignature] result', { error })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('서명이 수정되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[updateSignature] failed:', e)
      toast.error(e.message || '서명 수정 실패')
    },
  })
}

export function useDeleteSignature() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      console.log('[deleteSignature] start', { id })
      const { error } = await supabase.from('signatures').delete().eq('id', id)
      console.log('[deleteSignature] result', { error })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('서명이 삭제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteSignature] failed:', e)
      toast.error(e.message || '서명 삭제 실패')
    },
  })
}
