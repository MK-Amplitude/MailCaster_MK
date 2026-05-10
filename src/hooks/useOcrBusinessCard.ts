// 명함 사진 → 연락처 필드 추출. ContactFormDialog 에 prefill 로 사용.

import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export interface OcrFields {
  name?: string
  email?: string
  phone?: string
  company?: string
  parent_group?: string
  job_title?: string
  department?: string
}

export function useOcrBusinessCard() {
  return useMutation({
    mutationFn: async (imageDataUrl: string): Promise<OcrFields> => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke('ocr-business-card', {
        body: { image_data_url: imageDataUrl },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = '명함 인식에 실패했습니다.'
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
      const r = data as { fields: OcrFields }
      return r.fields ?? {}
    },
  })
}
