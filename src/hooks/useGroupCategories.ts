import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { GroupCategoryInsert, GroupCategoryUpdate } from '@/types/group'
import { toast } from 'sonner'

const QK = 'group-categories'

export function useGroupCategories() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('group_categories')
        .select('*')
        .eq('user_id', user!.id)
        .order('sort_order')
      if (error) throw error
      return data ?? []
    },
    enabled: !!user,
  })
}

export function useCreateCategory() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<GroupCategoryInsert, 'user_id'>) => {
      const { data: result, error } = await supabase
        .from('group_categories')
        .insert({ ...data, user_id: user!.id })
        .select()
        .single()
      if (error) throw error
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('카테고리가 생성되었습니다.')
    },
    onError: (e: Error) => {
      toast.error(e.message.includes('duplicate') ? '같은 이름의 카테고리가 있습니다.' : '생성 실패')
    },
  })
}

export function useUpdateCategory() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: GroupCategoryUpdate }) => {
      const { error } = await supabase.from('group_categories').update(data).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('카테고리가 수정되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[updateCategory] failed:', e)
      toast.error(e.message || '카테고리 수정 실패')
    },
  })
}

export function useDeleteCategory() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      console.log('[deleteCategory] start', { id })
      const { error } = await supabase.from('group_categories').delete().eq('id', id)
      console.log('[deleteCategory] result', { error })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast.success('카테고리가 삭제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteCategory] failed:', e)
      toast.error(e.message || '카테고리 삭제 실패')
    },
  })
}
