// 시퀀스(자동 후속 cadence) — 조회/CRUD/등록/정지 hook (고도화 Tier1-D).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'
import type { Database } from '@/types/database.types'

type SequenceRow = Database['mailcaster']['Tables']['sequences']['Row']
type SequenceInsert = Database['mailcaster']['Tables']['sequences']['Insert']
type StepRow = Database['mailcaster']['Tables']['sequence_steps']['Row']
type StepInsert = Database['mailcaster']['Tables']['sequence_steps']['Insert']
type EnrollmentRow = Database['mailcaster']['Tables']['sequence_enrollments']['Row']

const QK = 'sequences'

export interface SequenceListItem extends SequenceRow {
  step_count: number
  active_count: number
}

export interface StepInput {
  step_order: number
  wait_days: number
  subject: string
  body_html: string
}

export interface EnrollmentWithContact extends EnrollmentRow {
  contact: { id: string; name: string | null; email: string; company: string | null } | null
}

// 시퀀스 목록 + 스텝/진행중 수
export function useSequences() {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: [QK, currentOrg?.id],
    queryFn: async (): Promise<SequenceListItem[]> => {
      const { data: seqs, error } = await supabase
        .from('sequences')
        .select('*')
        .eq('org_id', currentOrg!.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      const list = (seqs ?? []) as SequenceRow[]
      if (list.length === 0) return []
      const ids = list.map((s) => s.id)

      const [stepsRes, enrRes] = await Promise.all([
        supabase.from('sequence_steps').select('sequence_id').in('sequence_id', ids),
        supabase
          .from('sequence_enrollments')
          .select('sequence_id, status')
          .in('sequence_id', ids)
          .eq('status', 'active'),
      ])
      const stepCount = new Map<string, number>()
      for (const r of (stepsRes.data ?? []) as Array<{ sequence_id: string }>) {
        stepCount.set(r.sequence_id, (stepCount.get(r.sequence_id) ?? 0) + 1)
      }
      const activeCount = new Map<string, number>()
      for (const r of (enrRes.data ?? []) as Array<{ sequence_id: string }>) {
        activeCount.set(r.sequence_id, (activeCount.get(r.sequence_id) ?? 0) + 1)
      }
      return list.map((s) => ({
        ...s,
        step_count: stepCount.get(s.id) ?? 0,
        active_count: activeCount.get(s.id) ?? 0,
      }))
    },
    enabled: !!currentOrg,
  })
}

// 단일 시퀀스 + 스텝
export function useSequence(id: string | undefined) {
  return useQuery({
    queryKey: [QK, 'detail', id],
    queryFn: async () => {
      const [seqRes, stepsRes] = await Promise.all([
        supabase.from('sequences').select('*').eq('id', id!).single(),
        supabase
          .from('sequence_steps')
          .select('*')
          .eq('sequence_id', id!)
          .order('step_order', { ascending: true }),
      ])
      if (seqRes.error) throw seqRes.error
      if (stepsRes.error) throw stepsRes.error
      return {
        sequence: seqRes.data as SequenceRow,
        steps: (stepsRes.data ?? []) as StepRow[],
      }
    },
    enabled: !!id,
  })
}

// 시퀀스의 enrollment 목록 (contact 조인)
export function useSequenceEnrollments(sequenceId: string | undefined) {
  return useQuery({
    queryKey: [QK, 'enrollments', sequenceId],
    queryFn: async (): Promise<EnrollmentWithContact[]> => {
      const { data, error } = await supabase
        .from('sequence_enrollments')
        .select('*, contact:contacts(id, name, email, company)')
        .eq('sequence_id', sequenceId!)
        .order('enrolled_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as unknown as EnrollmentWithContact[]
    },
    enabled: !!sequenceId,
  })
}

export interface SequenceOption {
  id: string
  name: string
}

// 셀렉터용 경량 목록 — active 시퀀스의 {id, name} 만. (캠페인 위저드 후속 시퀀스 선택 등)
export function useSequenceOptions() {
  const { currentOrg } = useAuth()
  return useQuery({
    queryKey: [QK, 'options', currentOrg?.id],
    queryFn: async (): Promise<SequenceOption[]> => {
      const { data, error } = await supabase
        .from('sequences')
        .select('id, name')
        .eq('org_id', currentOrg!.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as SequenceOption[]
    },
    enabled: !!currentOrg,
  })
}

export function useCreateSequence() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; description?: string }) => {
      if (!user || !currentOrg) throw new Error('로그인/조직 정보가 필요합니다.')
      const payload: SequenceInsert = {
        name: input.name,
        description: input.description ?? null,
        org_id: currentOrg.id,
        user_id: user.id,
      }
      const { data, error } = await supabase
        .from('sequences')
        .insert(payload)
        .select('id')
        .single()
      if (error) throw error
      return (data as { id: string }).id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('시퀀스를 만들었습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '시퀀스 생성 실패'),
  })
}

export function useUpdateSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id: string
      data: { name?: string; description?: string | null; status?: 'active' | 'archived' }
    }) => {
      const { error } = await supabase.from('sequences').update(input.data).eq('id', input.id)
      if (error) throw error
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: [QK, 'detail', v.id] })
    },
    onError: (e: Error) => toast.error(e.message || '시퀀스 수정 실패'),
  })
}

// 시퀀스 삭제 — sequence_steps / sequence_enrollments 는 ON DELETE CASCADE 로 자동 정리,
// campaigns.followup_sequence_id / thread_messages.sequence_id 는 ON DELETE SET NULL 로 안전.
export function useDeleteSequence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('sequences').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('시퀀스를 삭제했습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '시퀀스 삭제 실패'),
  })
}

// 스텝 전체 교체 — delete 후 insert (step_order UNIQUE 충돌 방지).
export function useSaveSequenceSteps() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sequenceId: string; steps: StepInput[] }) => {
      const { error: delErr } = await supabase
        .from('sequence_steps')
        .delete()
        .eq('sequence_id', input.sequenceId)
      if (delErr) throw delErr
      if (input.steps.length > 0) {
        const rows: StepInsert[] = input.steps.map((s, i) => ({
          sequence_id: input.sequenceId,
          step_order: i + 1,
          wait_days: s.wait_days,
          subject: s.subject,
          body_html: s.body_html,
        }))
        const { error: insErr } = await supabase.from('sequence_steps').insert(rows)
        if (insErr) throw insErr
      }
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: [QK, 'detail', v.sequenceId] })
      toast.success('스텝을 저장했습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '스텝 저장 실패'),
  })
}

export function useEnrollContacts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sequenceId: string; contactIds: string[] }) => {
      const { data, error } = await supabase.rpc('enroll_contacts_in_sequence', {
        p_sequence_id: input.sequenceId,
        p_contact_ids: input.contactIds,
      })
      if (error) throw error
      return (data as unknown as number) ?? 0
    },
    onSuccess: (count, v) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: [QK, 'enrollments', v.sequenceId] })
      toast.success(`${count}명을 시퀀스에 등록했습니다.`)
    },
    onError: (e: Error) => toast.error(e.message || '시퀀스 등록 실패'),
  })
}

// 그룹 전체를 시퀀스에 일괄 등록 (069)
export function useEnrollGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sequenceId: string; groupId: string }) => {
      const { data, error } = await supabase.rpc('enroll_group_in_sequence', {
        p_sequence_id: input.sequenceId,
        p_group_id: input.groupId,
      })
      if (error) throw error
      return (data as unknown as number) ?? 0
    },
    onSuccess: (count, v) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: [QK, 'enrollments', v.sequenceId] })
      toast.success(`${count}명을 시퀀스에 등록했습니다.`)
    },
    onError: (e: Error) => toast.error(e.message || '시퀀스 등록 실패'),
  })
}

export interface StepFunnelRow {
  step_order: number
  sent: number
  opened: number
  replied: number
}

// 스텝별 전환 퍼널 — 발송/오픈/회신 (Tier3-b)
export function useSequenceStepFunnel(sequenceId: string | undefined) {
  return useQuery({
    queryKey: [QK, 'funnel', sequenceId],
    queryFn: async (): Promise<StepFunnelRow[]> => {
      const { data, error } = await supabase.rpc('sequence_step_funnel', {
        p_sequence_id: sequenceId!,
      })
      if (error) throw error
      return ((data ?? []) as StepFunnelRow[]).map((r) => ({
        step_order: Number(r.step_order),
        sent: Number(r.sent) || 0,
        opened: Number(r.opened) || 0,
        replied: Number(r.replied) || 0,
      }))
    },
    enabled: !!sequenceId,
  })
}

export function useStopEnrollment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { enrollmentId: string; sequenceId: string }) => {
      const { error } = await supabase.rpc('stop_enrollment', {
        p_enrollment_id: input.enrollmentId,
        p_reason: 'manual',
      })
      if (error) throw error
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: [QK] })
      qc.invalidateQueries({ queryKey: [QK, 'enrollments', v.sequenceId] })
      toast.success('등록을 중단했습니다.')
    },
    onError: (e: Error) => toast.error(e.message || '중단 실패'),
  })
}
