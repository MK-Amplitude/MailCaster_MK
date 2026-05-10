// contact_notes (migration 030) CRUD 훅.
// 한 연락처의 메모/통화/미팅 기록을 시간순으로 조회 + 추가/수정/삭제.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { toast } from 'sonner'
import type { ContactNote, ContactNoteKind } from '@/types/contactNote'

const QK = 'contact-notes'

export function useContactNotes(contactId: string | null | undefined) {
  return useQuery({
    queryKey: [QK, contactId],
    queryFn: async (): Promise<ContactNote[]> => {
      // contact_notes 테이블은 generated types 에 아직 없음 — 캐스트로 우회.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      const { data, error } = await sb
        .from('contact_notes')
        .select('*')
        .eq('contact_id', contactId!)
        .order('occurred_at', { ascending: false })
        .limit(50)
      if (error) throw error
      return (data ?? []) as ContactNote[]
    },
    enabled: !!contactId,
  })
}

interface CreateInput {
  contact_id: string
  kind: ContactNoteKind
  body: string
  /** 미지정 시 now() */
  occurred_at?: string
}

export function useCreateContactNote() {
  const { user, currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (input: CreateInput): Promise<ContactNote> => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('현재 조직이 설정되지 않았습니다.')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      const { data, error } = await sb
        .from('contact_notes')
        .insert({
          contact_id: input.contact_id,
          user_id: user.id,
          org_id: currentOrg.id,
          kind: input.kind,
          body: input.body,
          occurred_at: input.occurred_at ?? new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw error
      return data as ContactNote
    },
    onSuccess: (note) => {
      qc.invalidateQueries({ queryKey: [QK, note.contact_id] })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '메모 추가 실패')
    },
  })
}

interface UpdateInput {
  id: string
  contact_id: string  // 캐시 invalidation 용
  body?: string
  kind?: ContactNoteKind
  occurred_at?: string
}

export function useUpdateContactNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateInput): Promise<ContactNote> => {
      const { id, contact_id: _, ...patch } = input
      void _
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      const { data, error } = await sb
        .from('contact_notes')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return data as ContactNote
    },
    onSuccess: (note) => {
      qc.invalidateQueries({ queryKey: [QK, note.contact_id] })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '메모 수정 실패')
    },
  })
}

export function useDeleteContactNote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; contact_id: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      const { error } = await sb.from('contact_notes').delete().eq('id', input.id)
      if (error) throw error
      return input
    },
    onSuccess: ({ contact_id }) => {
      qc.invalidateQueries({ queryKey: [QK, contact_id] })
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '메모 삭제 실패')
    },
  })
}
