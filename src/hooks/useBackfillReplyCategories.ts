// 028 (reply_category) 도입 이전에 도착한 답장 일괄 백필 분류.
// 캠페인 detail 페이지의 "이전 답장 분류" 버튼이 호출.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'

export interface BackfillResult {
  processed: number
  classified: number
  errors: number
  remaining: number
}

interface Input {
  campaignId?: string
  /** 'unclear' 도 재분류 대상에 포함 */
  includeUnclear?: boolean
  /** 한 호출에서 처리할 최대 — 기본 50, 최대 200 */
  limit?: number
}

export function useBackfillReplyCategories() {
  const { currentOrg } = useAuth()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (input: Input): Promise<BackfillResult> => {
      if (!currentOrg) throw new Error('조직 정보가 없습니다.')
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke(
        'classify-existing-replies',
        {
          body: {
            org_id: currentOrg.id,
            campaign_id: input.campaignId,
            include_unclear: input.includeUnclear,
            limit: input.limit,
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
      if (error) {
        let friendly = '백필 분류에 실패했습니다.'
        try {
          const resp = (error as { context?: Response }).context
          if (resp) {
            const body = (await resp.json()) as {
              error?: string
              message?: string
              detail?: string
            }
            friendly = body.error || body.message || body.detail || friendly
          }
        } catch {
          friendly = error.message || friendly
        }
        throw new Error(friendly)
      }
      return data as BackfillResult
    },
    onSuccess: () => {
      // 캠페인/수신자 캐시 무효화 — UI 가 새 reply_category 를 받도록.
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      qc.invalidateQueries({ queryKey: ['contact-engagement'] })
      qc.invalidateQueries({ queryKey: ['campaign-engagement'] })
    },
  })
}
