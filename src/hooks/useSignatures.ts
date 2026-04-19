import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { SignatureInsert, SignatureUpdate } from '@/types/signature'
import { toast } from 'sonner'

const QK = 'signatures'

export function useSignatures() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('signatures')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!user,
  })
}

export function useCreateSignature() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<SignatureInsert, 'user_id'>) => {
      console.log('[createSignature] start', { data, userId: user?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      const { data: result, error } = await supabase
        .from('signatures')
        .insert({ ...data, user_id: user.id })
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
