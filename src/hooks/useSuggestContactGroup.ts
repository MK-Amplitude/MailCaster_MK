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
      // sb_publishable_ 형식 anon key는 JWT 형식이 아니라 Supabase relay가 차단함.
      // 세션 JWT를 명시적으로 가져와 Authorization 헤더에 직접 전달.
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('suggest-contact-group', {
        body: {
          description,
          org_id: orgId,
          max_results: maxResults,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        // FunctionsHttpError.context IS the Response object (not { response: Response }).
        // 우선순위: body.error (친화 메시지) > body.message (relay) > error.message (SDK 기본)
        let friendly = 'AI 그룹 제안에 실패했습니다.'
        try {
          const resp = (error as { context?: Response }).context
          if (resp) {
            const body = (await resp.json()) as {
              error?: string
              detail?: string
              message?: string
            }
            friendly = body.error || body.message || body.detail || friendly
          }
        } catch {
          friendly = error.message || friendly
        }
        throw new Error(friendly)
      }
      return data as SuggestGroupResult
    },
  })
}
