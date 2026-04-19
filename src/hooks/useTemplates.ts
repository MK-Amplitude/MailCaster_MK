import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import type { TemplateInsert, TemplateUpdate } from '@/types/template'
import { toast } from 'sonner'

const QK = 'templates'

export function useTemplates() {
  const { user } = useAuth()

  return useQuery({
    queryKey: [QK],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('user_id', user!.id)
        .order('updated_at', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    enabled: !!user,
  })
}

export function useCreateTemplate() {
  const { user } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (data: Omit<TemplateInsert, 'user_id'>) => {
      console.log('[createTemplate] start', { data, userId: user?.id })
      if (!user) throw new Error('로그인이 필요합니다.')
      const { data: result, error } = await supabase
        .from('templates')
        .insert({ ...data, user_id: user.id })
        .select()
        .single()
      console.log('[createTemplate] result', { result, error })
      if (error) throw error
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('템플릿이 생성되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[createTemplate] failed:', e)
      toast.error(e.message || '템플릿 생성 실패')
    },
  })
}

export function useUpdateTemplate() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: TemplateUpdate }) => {
      const { error } = await supabase.from('templates').update(data).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('템플릿이 수정되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[updateTemplate] failed:', e)
      toast.error(e.message || '템플릿 수정 실패')
    },
  })
}

export function useDeleteTemplate() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      console.log('[deleteTemplate] start', { id })

      // 사용 중 체크: campaign_blocks 가 이 템플릿을 참조하는지 미리 확인.
      // FK ON DELETE CASCADE 를 걸지 않은 이유는, 템플릿을 실수로 지웠을 때
      // 이미 예약됐거나 발송 중인 캠페인의 블록이 줄줄이 삭제되면 복구 불가능하기 때문.
      // 대신 어느 캠페인이 쓰고 있는지 사용자에게 알려주고 의사결정을 맡긴다.
      //
      // RLS 에 의해 자기 소유 캠페인만 보이지만, 그걸로 충분히 "어디서 쓰는지" 를 보여줄 수 있음.
      // (혹여 DB 제약으로 남의 캠페인에서도 참조 중이면 실제 delete 단계에서 23503 으로 잡힘.)
      const { data: usages, error: usageErr } = await supabase
        .from('campaign_blocks')
        .select('campaign_id, campaigns!inner(name, status)')
        .eq('template_id', id)
        .limit(10)
      if (usageErr) {
        // campaign_blocks 조회 자체가 실패 — 네트워크/권한 등. 진짜 delete 시도는 해본다.
        console.warn('[deleteTemplate] usage check failed, proceeding anyway', usageErr)
      } else if (usages && usages.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const names = usages
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((u: any) => u.campaigns?.name)
          .filter((n: string | undefined): n is string => !!n)
        const sample = names.slice(0, 3).join(', ')
        const more = names.length > 3 ? ` 외 ${names.length - 3}개` : ''
        throw new Error(
          `이 템플릿은 ${names.length}개 메일 발송에서 사용 중입니다 (${sample}${more}). 해당 메일 발송에서 블록을 먼저 제거하거나 삭제한 뒤 다시 시도해주세요.`,
        )
      }

      const { error } = await supabase.from('templates').delete().eq('id', id)
      console.log('[deleteTemplate] result', { error })
      if (error) {
        // 23503 = foreign_key_violation — 사전 체크 후에도 레이스로 들어올 수 있음.
        // 기본 Postgres 메시지(영문)는 사용자에게 불친절하므로 한국어로 덮어쓴다.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyErr = error as any
        if (anyErr?.code === '23503') {
          throw new Error(
            '이 템플릿을 사용 중인 메일 발송이 있어 삭제할 수 없습니다. 해당 메일 발송에서 블록을 먼저 제거해주세요.',
          )
        }
        throw error
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] })
      toast.success('템플릿이 삭제되었습니다.')
    },
    onError: (e: Error) => {
      console.error('[deleteTemplate] failed:', e)
      toast.error(e.message || '템플릿 삭제 실패')
    },
  })
}
