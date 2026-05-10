// 이메일 도메인 MX 사전 검증.
// 캠페인 발송 직전 (Step3) 호출해 invalid 도메인의 이메일을 사용자에게 알린다.
//
// 동작은 read-only — 결과만 반환, 실제 차단/제거는 사용자가 결정.

import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface ValidationResult {
  invalid_emails: string[]
  invalid_domains: string[]
  malformed_count: number
  checked_domains: number
}

export function useValidateEmails() {
  return useMutation({
    mutationFn: async (emails: string[]): Promise<ValidationResult> => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('validate-email-domains', {
        body: { emails },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = '이메일 검증에 실패했습니다.'
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
      return data as ValidationResult
    },
  })
}
