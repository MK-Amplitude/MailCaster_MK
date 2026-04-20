// ============================================================
// useOrganization — 조직/멤버/초대 관련 React Query 훅
// ------------------------------------------------------------
// 제공하는 훅:
//   useOrgs()              내가 속한 조직 목록
//   useOrgMembers(orgId)   특정 조직의 멤버 + 프로필 조인
//   useOrgInvitations(orgId) 해당 조직의 pending 초대 목록
//   useMyPendingInvitations()  내 이메일로 온 미수락 초대 (로그인 직후 배너용)
//
//   useCreateOrg()         새 조직 + 나를 owner 로 추가 (2-step tx)
//   useUpdateOrg()         조직 정보 수정 (admin+)
//   useDeleteOrg()         조직 삭제 (owner)
//
//   useInviteMember()      이메일 초대 생성
//   useCancelInvitation()  초대 취소
//   useAcceptPendingInvitations()  RPC 호출 — 로그인 시 본인 이메일의 초대 일괄 수락
//   useRemoveMember()      멤버 제거 (admin+ 또는 본인 탈퇴)
//   useUpdateMemberRole()  멤버 역할 변경 (admin+)
// ============================================================

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { Organization, OrgMember, OrgInvitation, OrgRole, OrgInviteRole } from '@/types/org'
import { toast } from 'sonner'

const ORGS_KEY = 'orgs'
const ORG_MEMBERS_KEY = 'org-members'
const ORG_INVITATIONS_KEY = 'org-invitations'
const MY_INVITATIONS_KEY = 'my-pending-invitations'

// ============================================================
// 조회
// ============================================================

export function useOrgs() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [ORGS_KEY, user?.id],
    queryFn: async (): Promise<Array<Organization & { role: OrgRole }>> => {
      // org_members + organizations 조인 — RLS 가 자동 필터
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('org_members') as any)
        .select('role, organizations(id, name, slug, created_by, created_at, updated_at)')
        .eq('user_id', user!.id)
        .order('joined_at', { ascending: true })
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({ ...row.organizations, role: row.role }))
    },
    enabled: !!user,
  })
}

export function useOrgMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: [ORG_MEMBERS_KEY, orgId],
    queryFn: async (): Promise<OrgMember[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('org_members') as any)
        .select('org_id, user_id, role, invited_by, joined_at, profiles:user_id(email, display_name)')
        .eq('org_id', orgId!)
        .order('joined_at', { ascending: true })
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({
        org_id: row.org_id,
        user_id: row.user_id,
        role: row.role,
        invited_by: row.invited_by,
        joined_at: row.joined_at,
        email: row.profiles?.email,
        display_name: row.profiles?.display_name ?? null,
      }))
    },
    enabled: !!orgId,
  })
}

export function useOrgInvitations(orgId: string | undefined) {
  return useQuery({
    queryKey: [ORG_INVITATIONS_KEY, orgId],
    queryFn: async (): Promise<OrgInvitation[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('org_invitations') as any)
        .select('*')
        .eq('org_id', orgId!)
        .is('accepted_at', null)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as OrgInvitation[]
    },
    enabled: !!orgId,
  })
}

// 내 이메일로 온 미수락 초대 (로그인 직후 배너용)
export function useMyPendingInvitations() {
  const { user } = useAuth()
  return useQuery({
    queryKey: [MY_INVITATIONS_KEY, user?.email],
    queryFn: async (): Promise<Array<OrgInvitation & { org_name: string }>> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('org_invitations') as any)
        .select('*, organizations(name)')
        .ilike('email', user!.email!)
        .is('accepted_at', null)
      if (error) throw error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({
        ...row,
        org_name: row.organizations?.name ?? '(알 수 없음)',
      }))
    },
    enabled: !!user?.email,
  })
}

// ============================================================
// 조직 CRUD
// ============================================================

export function useCreateOrg() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error('로그인이 필요합니다.')

      // 1) organizations INSERT (created_by = 나, RLS WITH CHECK 통과)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: org, error: e1 } = await (supabase.from('organizations') as any)
        .insert({ name, created_by: user.id })
        .select()
        .single()
      if (e1) throw e1

      // 2) org_members 에 나를 owner 로 삽입 (RLS: user_id=me AND role=owner 허용)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: e2 } = await (supabase.from('org_members') as any).insert({
        org_id: org.id,
        user_id: user.id,
        role: 'owner',
        invited_by: user.id,
      })
      if (e2) {
        // rollback — 멤버 추가 실패 시 조직 정리 시도 (RLS owner 정책에 막힐 수 있으므로 로깅만)
        console.error('[createOrg] member insert failed, orphan org:', org.id, e2)
        throw e2
      }

      return org as Organization
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ORGS_KEY] })
      toast.success('조직이 생성되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '조직 생성 실패'),
  })
}

export function useUpdateOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('organizations') as any)
        .update({ name })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ORGS_KEY] })
      toast.success('조직 정보가 수정되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '조직 수정 실패'),
  })
}

export function useDeleteOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('organizations') as any).delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [ORGS_KEY] })
      toast.success('조직이 삭제되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '조직 삭제 실패'),
  })
}

// ============================================================
// 멤버 / 초대
// ============================================================

export function useInviteMember() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      orgId,
      email,
      role,
    }: {
      orgId: string
      email: string
      role: OrgInviteRole
    }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('org_invitations') as any).insert({
        org_id: orgId,
        email: email.trim().toLowerCase(),
        role,
        invited_by: user!.id,
      })
      if (error) throw error
    },
    onSuccess: (_data, { orgId }) => {
      qc.invalidateQueries({ queryKey: [ORG_INVITATIONS_KEY, orgId] })
      toast.success('초대가 발송되었습니다.')
    },
    onError: (e: Error) => {
      const msg = e.message.includes('duplicate')
        ? '이미 초대된 이메일입니다.'
        : e.message || '초대 실패'
      toast.error(msg)
    },
  })
}

export function useCancelInvitation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }: { id: string; orgId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('org_invitations') as any).delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: (_data, { orgId }) => {
      qc.invalidateQueries({ queryKey: [ORG_INVITATIONS_KEY, orgId] })
      toast.success('초대가 취소되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '취소 실패'),
  })
}

// 로그인 직후 호출 — 내 이메일 앞으로 온 초대 자동 수락
export function useAcceptPendingInvitations() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('accept_pending_invitations')
      if (error) throw error
      return (data as number) ?? 0
    },
    onSuccess: (count) => {
      if (count > 0) {
        qc.invalidateQueries({ queryKey: [ORGS_KEY] })
        qc.invalidateQueries({ queryKey: [MY_INVITATIONS_KEY] })
        toast.success(`${count}개 조직에 합류했습니다.`)
      }
    },
  })
}

export function useRemoveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ orgId, userId }: { orgId: string; userId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('org_members') as any)
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: (_data, { orgId }) => {
      qc.invalidateQueries({ queryKey: [ORG_MEMBERS_KEY, orgId] })
      qc.invalidateQueries({ queryKey: [ORGS_KEY] })
      toast.success('멤버가 제거되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '멤버 제거 실패'),
  })
}

export function useUpdateMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      orgId,
      userId,
      role,
    }: {
      orgId: string
      userId: string
      role: OrgRole
    }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('org_members') as any)
        .update({ role })
        .eq('org_id', orgId)
        .eq('user_id', userId)
      if (error) throw error
    },
    onSuccess: (_data, { orgId }) => {
      qc.invalidateQueries({ queryKey: [ORG_MEMBERS_KEY, orgId] })
      toast.success('역할이 변경되었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '역할 변경 실패'),
  })
}
