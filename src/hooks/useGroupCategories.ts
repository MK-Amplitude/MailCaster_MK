import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { GroupCategoryInsert, GroupCategoryUpdate } from '@/types/group'
import { toast } from 'sonner'

const QK = 'group-categories'

// 카테고리는 조직 단위 공유. 기본값(4개) 은 DB 트리거 (016) 가 자동 생성.
export function useGroupCategories() {
  const { user, currentOrg } = useAuth()

  return useQuery({
    queryKey: [QK, currentOrg?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('group_categories')
        .select('*')
        .eq('org_id', currentOrg!.id)
        .order('sort_order')
      if (error) throw error
      return data ?? []
    },
    enabled: !!user && !!currentOrg,
  })
}

export function useCreateCategory() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<GroupCategoryInsert, 'user_id' | 'org_id'>) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      const { data: result, error } = await supabase
        .from('group_categories')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({ ...data, user_id: user.id, org_id: currentOrg.id } as any)
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
