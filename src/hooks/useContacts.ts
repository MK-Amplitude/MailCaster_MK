import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { ContactInsert, ContactUpdate, ContactWithGroups, ContactFilters } from '@/types/contact'
import type { ContactCommon } from '@/types/org'
import { resolveCompanyForContact } from '@/lib/resolveCompany'
import { toast } from 'sonner'

const QUERY_KEY = 'contacts'
const COMMON_QUERY_KEY = 'contacts-common'

// 주소록 범위:
//   'mine' = 내가 오너인 연락처만
//   'org'  = 현재 조직의 전체 연락처 (소유자별 중복 유지 — 오너 컬럼으로 구분)
export type ContactScope = 'mine' | 'org'

export interface ContactQueryOptions extends ContactFilters {
  scope?: ContactScope
}

export function useContacts(filters?: ContactQueryOptions) {
  const { user, currentOrg } = useAuth()
  const scope: ContactScope = filters?.scope ?? 'org'

  return useQuery({
    queryKey: [QUERY_KEY, currentOrg?.id, scope, filters],
    queryFn: async () => {
      let query = supabase
        .from('contact_with_groups')
        .select('*')
        .eq('org_id', currentOrg!.id)
        .order('created_at', { ascending: false })

      if (scope === 'mine') {
        query = query.eq('user_id', user!.id)
      }

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
    enabled: !!user && !!currentOrg,
  })
}

// "공통(dedupe)" 뷰 — 같은 이메일의 중복 연락처를 하나로 합쳐서 본다.
// campaigns 수신자 선택 시 중복 발송 방지 용도로도 사용.
export function useContactsCommon() {
  const { currentOrg } = useAuth()

  return useQuery({
    queryKey: [COMMON_QUERY_KEY, currentOrg?.id],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('contacts_common') as any)
        .select('*')
        .eq('org_id', currentOrg!.id)
        .order('first_created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as ContactCommon[]
    },
    enabled: !!currentOrg,
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
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<ContactInsert, 'user_id' | 'org_id'>) => {
      console.log('[createContact] start', { data, userId: user?.id, orgId: currentOrg?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      // email 정규화 — 019/020 트리거가 LOWER(email) 로 비교하므로
      // 저장 시점에 trim().toLowerCase() 해두면 데이터 자체가 일관됨.
      // (useContactImport.ts 와 동일한 규칙.)
      const normalizedEmail = data.email?.trim().toLowerCase() ?? data.email
      // company 입력 → company_raw 로 함께 보관 (이미 설정돼 있으면 유지)
      const payload = {
        ...data,
        email: normalizedEmail,
        user_id: user.id,
        org_id: currentOrg.id,
        company_raw: data.company_raw ?? data.company ?? null,
      }
      const { data: result, error } = await supabase
        .from('contacts')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(payload as any)
        .select()
        .single()
      console.log('[createContact] result', { result, error })
      if (error) throw error
      return result
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] })
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
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
      // email 변경 시 정규화 — create/import 와 동일한 trim().toLowerCase().
      // 019 트리거가 LOWER() 로 비교하지만 데이터 자체를 정규화해 UNIQUE(org_id, email)
      // 제약이 대소문자 차이로 우회되는 걸 막는다.
      if (Object.prototype.hasOwnProperty.call(data, 'email') && typeof data.email === 'string') {
        payload.email = data.email.trim().toLowerCase()
      }
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
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
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
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
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
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
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
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
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
      qc.invalidateQueries({ queryKey: [COMMON_QUERY_KEY] })
      qc.invalidateQueries({ queryKey: ['groups'] })
      qc.invalidateQueries({ queryKey: ['group-members', groupId] })
    },
    onError: (e: Error) => {
      console.error('[removeContactFromGroup] failed:', e)
      toast.error(e.message || '그룹에서 제거 실패')
    },
  })
}
