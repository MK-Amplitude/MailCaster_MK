import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { GroupInsert, GroupUpdate } from '@/types/group'
import { toast } from 'sonner'

export function useGroups(categoryId?: string) {
  const { user } = useAuth()

  return useQuery({
    queryKey: ['groups', categoryId],
    queryFn: async () => {
      let query = supabase
        .from('groups')
        .select('*, group_categories(id, name, color, icon)')
        .eq('user_id', user!.id)
        .order('name')

      if (categoryId) {
        query = query.eq('category_id', categoryId)
      }

      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as unknown as Array<import('@/types/group').Group & { group_categories: { id: string; name: string; color: string | null; icon: string | null } | null }>
    },
    enabled: !!user,
  })
}

export function useGroupMembers(groupId: string) {
  return useQuery({
    queryKey: ['group-members', groupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contact_groups')
        .select('added_at, contacts(id, email, name, company, department, job_title, is_unsubscribed, is_bounced)')
        .eq('group_id', groupId)
        .order('added_at', { ascending: false })
      if (error) throw error
      type MemberRow = { added_at: string; contacts: { id: string; email: string; name: string | null; company: string | null; department: string | null; job_title: string | null; is_unsubscribed: boolean; is_bounced: boolean } | null }
      return (data as unknown as MemberRow[]).map((row) => ({ ...row.contacts, added_at: row.added_at }))
    },
    enabled: !!groupId,
  })
}

export function useCreateGroup() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<GroupInsert, 'user_id'>) => {
      const { data: result, error } = await supabase
        .from('groups')
        .insert({ ...data, user_id: user!.id })
        .select()
        .single()
      if (error) throw error
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast.success('그룹이 생성되었습니다.')
    },
    onError: () => toast.error('그룹 생성 실패'),
  })
}

export function useUpdateGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: GroupUpdate }) => {
      const { error } = await supabase.from('groups').update(data).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast.success('그룹이 수정되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[updateGroup] failed:', e)
      toast.error(e.message || '그룹 수정 실패')
    },
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      console.log('[deleteGroup] start', { id })
      const { error } = await supabase.from('groups').delete().eq('id', id)
      console.log('[deleteGroup] result', { error })
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast.success('그룹이 삭제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteGroup] failed:', e)
      toast.error(e.message || '그룹 삭제 실패')
    },
  })
}

export function useAddMemberToGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ contactId, groupId }: { contactId: string; groupId: string }) => {
      const { error } = await supabase
        .from('contact_groups')
        .upsert({ contact_id: contactId, group_id: groupId }, {
          onConflict: 'contact_id,group_id',
          ignoreDuplicates: true,
        })
      if (error) throw error
    },
    onSuccess: (_data, { groupId }) => {
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      toast.success('멤버가 추가되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[addMemberToGroup] failed:', e)
      toast.error(e.message || '멤버 추가 실패')
    },
  })
}

export function useRemoveMemberFromGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ contactId, groupId }: { contactId: string; groupId: string }) => {
      const { error } = await supabase
        .from('contact_groups')
        .delete()
        .eq('contact_id', contactId)
        .eq('group_id', groupId)
      if (error) throw error
    },
    onSuccess: (_data, { groupId }) => {
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
      qc.invalidateQueries({ queryKey: ['groups'] })
    },
    onError: (e: Error) => {
      console.error('[removeMemberFromGroup] failed:', e)
      toast.error(e.message || '멤버 제거 실패')
    },
  })
}

export function useRemoveMembersFromGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ contactIds, groupId }: { contactIds: string[]; groupId: string }) => {
      const { error } = await supabase
        .from('contact_groups')
        .delete()
        .in('contact_id', contactIds)
        .eq('group_id', groupId)
      if (error) throw error
    },
    onSuccess: (_data, { groupId, contactIds }) => {
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      toast.success(`${contactIds.length}명 제거되었습니다.`)
    },
    onError: (e: Error) => {
      console.error('[removeMembersFromGroup] failed:', e)
      toast.error(e.message || '멤버 제거 실패')
    },
  })
}
