import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { CampaignBlockWithTemplate } from '@/types/campaign'
import { toast } from 'sonner'

const QK = 'campaign-blocks'

export function useCampaignBlocks(campaignId: string | undefined) {
  return useQuery({
    queryKey: [QK, campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('campaign_blocks')
        .select('id, campaign_id, template_id, position, created_at, template:templates(id, name, subject, body_html)')
        .eq('campaign_id', campaignId!)
        .order('position', { ascending: true })
      if (error) throw error
      return (data ?? []) as unknown as CampaignBlockWithTemplate[]
    },
    enabled: !!campaignId,
  })
}

export function useAddCampaignBlock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ campaignId, templateId }: { campaignId: string; templateId: string }) => {
      const { data: existing, error: qErr } = await supabase
        .from('campaign_blocks')
        .select('position')
        .eq('campaign_id', campaignId)
        .order('position', { ascending: false })
        .limit(1)
      if (qErr) throw qErr
      const nextPos = (existing?.[0]?.position ?? -1) + 1

      const { error } = await supabase
        .from('campaign_blocks')
        .insert({ campaign_id: campaignId, template_id: templateId, position: nextPos })
      if (error) throw error
    },
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: [QK, campaignId] })
    },
    onError: (e: Error) => {
      console.error('[addCampaignBlock] failed:', e)
      toast.error(e.message || '블록 추가 실패')
    },
  })
}

export function useRemoveCampaignBlock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, campaignId }: { id: string; campaignId: string }) => {
      const { error } = await supabase.from('campaign_blocks').delete().eq('id', id)
      if (error) throw error
      return { campaignId }
    },
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: [QK, campaignId] })
    },
    onError: (e: Error) => {
      console.error('[removeCampaignBlock] failed:', e)
      toast.error(e.message || '블록 제거 실패')
    },
  })
}

// 전체 블록의 position을 배열 순서로 재설정
// UNIQUE (campaign_id, position) 은 DEFERRABLE 이므로 트랜잭션 내 swap 가능
export function useReorderCampaignBlocks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ campaignId, orderedIds }: { campaignId: string; orderedIds: string[] }) => {
      // 임시 음수 position 으로 이동해 충돌 회피
      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('campaign_blocks')
          .update({ position: -(i + 1) })
          .eq('id', orderedIds[i])
        if (error) throw error
      }
      // 최종 position 설정
      for (let i = 0; i < orderedIds.length; i++) {
        const { error } = await supabase
          .from('campaign_blocks')
          .update({ position: i })
          .eq('id', orderedIds[i])
        if (error) throw error
      }
      return { campaignId }
    },
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: [QK, campaignId] })
    },
    onError: (e: Error) => {
      console.error('[reorderCampaignBlocks] failed:', e)
      toast.error(e.message || '순서 변경 실패')
    },
  })
}
