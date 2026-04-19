import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { ContactInsert, ContactUpdate, ContactWithGroups, ContactFilters } from '@/types/contact'
import { resolveCompanyForContact } from '@/lib/resolveCompany'
import { toast } from 'sonner'

const QUERY_KEY = 'contacts'

export function useContacts(filters?: ContactFilters) {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QUERY_KEY, filters],
    queryFn: async () => {
      let query = supabase
        .from('contact_with_groups')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })

      // 상태 필터만 서버에서 처리. 텍스트 검색은 클라이언트에서(초성 지원).
      if (filters?.status === 'unsubscribed') {
        query = query.eq('is_unsubscribed', true)
      } else if (filters?.status === 'bounced') {
        query = query.eq('is_bounced', true)
      } else if (filters?.status === 'normal') {
        query = query.eq('is_unsubscribed', false).eq('is_bounced', false)
      } else if (filters?.status === 'needs_verification') {
        // 회사명 확인이 필요한 상태들 (pending=재시도 대기, failed=에러, not_found=모델이 모름)
        query = query.in('company_lookup_status', ['pending', 'failed', 'not_found'])
      }

      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as unknown as ContactWithGroups[]
    },
    enabled: !!user,
  })
}

export function useContactGroups(contactId: string) {
  return useQuery({
    queryKey: ['contact-groups', contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contact_groups')
        .select('group_id, groups(id, name, color, category_id, group_categories(name, color))')
        .eq('contact_id', contactId)
      if (error) throw error
      return data ?? []
    },
    enabled: !!contactId,
  })
}

export function useCreateContact() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<ContactInsert, 'user_id'>) => {
      console.log('[createContact] start', { data, userId: user?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      // company 입력 → company_raw 로 함께 보관 (이미 설정돼 있으면 유지)
      const payload = {
        ...data,
        user_id: user.id,
        company_raw: data.company_raw ?? data.company ?? null,
      }
      const { data: result, error } = await supabase
        .from('contacts')
        .insert(payload)
        .select()
        .single()
      console.log('[createContact] result', { result, error })
      if (error) throw error
      return result
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      toast.success('연락처가 추가되었습니다.')
      if (result?.id && result.company_raw) {
        resolveCompanyForContact({
          rawName: result.company_raw,
          contactId: result.id,
          qc,
        })
      }
    },
    onError: (e: Error) => {
      toast.error(e.message.includes('duplicate') ? '이미 등록된 이메일입니다.' : '추가 실패')
    },
  })
}

export function useUpdateContact() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: ContactUpdate }) => {
      // company 사용자 수정 → company_raw 도 동시 업데이트
      const payload: ContactUpdate = { ...data }
      if (Object.prototype.hasOwnProperty.call(data, 'company')) {
        payload.company_raw = data.company ?? null
        // 새 회사명 → 재조회 대기
        payload.company_lookup_status = 'pending'
      }
      const { error } = await supabase.from('contacts').update(payload).eq('id', id)
      if (error) throw error
      return { id, companyChanged: 'company' in data, company: data.company }
    },
    onSuccess: ({ id, companyChanged, company }) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      toast.success('연락처가 수정되었습니다.')
      if (companyChanged && company && company.trim()) {
        resolveCompanyForContact({ rawName: company, contactId: id, qc })
      }
    },
    onError: () => toast.error('수정 실패'),
  })
}

export function useDeleteContacts() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (ids: string[]) => {
      console.log('[deleteContacts] start', { count: ids.length })
      const { error } = await supabase.from('contacts').delete().in('id', ids)
      console.log('[deleteContacts] result', { error })
      if (error) throw error
    },
    onSuccess: (_, ids) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      toast.success(`${ids.length}개의 연락처가 삭제되었습니다.`)
    },
    onError: (e: Error) => {
      console.error('[deleteContacts] failed:', e)
      toast.error(e.message || '삭제 실패')
    },
  })
}

export function useToggleUnsubscribe() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, unsubscribe }: { id: string; unsubscribe: boolean }) => {
      const { error } = await supabase
        .from('contacts')
        .update({
          is_unsubscribed: unsubscribe,
          unsubscribed_at: unsubscribe ? new Date().toISOString() : null,
        })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: (_data, { unsubscribe }) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      toast.success(unsubscribe ? '수신거부 처리되었습니다.' : '수신거부가 해제되었습니다.')
    },
  })
}

export function useAddContactsToGroup() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ contactIds, groupId }: { contactIds: string[]; groupId: string }) => {
      const rows = contactIds.map((contact_id) => ({ contact_id, group_id: groupId }))
      const { error } = await supabase.from('contact_groups').upsert(rows, {
        onConflict: 'contact_id,group_id',
        ignoreDuplicates: true,
      })
      if (error) throw error
    },
    onSuccess: (_data, { groupId }) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
      toast.success('그룹에 추가되었습니다.')
    },
  })
}

export function useRemoveContactFromGroup() {
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
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
    },
    onError: (e: Error) => {
      console.error('[removeContactFromGroup] failed:', e)
      toast.error(e.message || '그룹에서 제거 실패')
    },
  })
}
