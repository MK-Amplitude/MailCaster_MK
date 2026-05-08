import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface SuggestGroupResult {
  matched_ids: string[]
  group_name: string
  reasoning: string
  total_scanned: number
}

interface SuggestGroupArgs {
  description: string
  orgId: string
  maxResults?: number
}

// 자연어 쿼리 → AI 매칭된 연락처 ID 리스트.
// 조회만 수행 (DB 변경 없음) — 사용자가 결과 검토 후 그룹 생성은 별도 mutation.
export function useSuggestContactGroup() {
  return useMutation({
    mutationFn: async ({
      description,
      orgId,
      maxResults,
    }: SuggestGroupArgs): Promise<SuggestGroupResult> => {
      const { data, error } = await supabase.functions.invoke('suggest-contact-group', {
        body: {
          description,
          org_id: orgId,
          max_results: maxResults,
        },
      })
      if (error) {
        // supabase.functions.invoke 는 non-2xx 응답을 generic 에러로 감싸기 때문에
        // 실제 detail 은 error.context.response 에 있다 — 가능하면 본문에서 추출.
        let detail = error.message || 'AI 그룹 제안 실패'
        try {
          const errAny = error as { context?: { response?: Response } }
          const resp = errAny.context?.response
          if (resp) {
            const body = (await resp.json()) as { error?: string; detail?: string }
            detail = body.detail || body.error || detail
          }
        } catch {
          // 파싱 실패 시 기본 메시지 사용
        }
        throw new Error(detail)
      }
      return data as SuggestGroupResult
    },
  })
}
