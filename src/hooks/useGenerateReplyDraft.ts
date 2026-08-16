// 답장 초안 AI 생성 — generate-reply-draft Edge Function 호출.
// ThreadComposeDialog (reply 모드) 의 "AI 초안" 버튼에서 사용.

import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { useAuth } from './useAuth'

interface DraftInput {
  contactId?: string | null
  originalBodyHtml: string
  originalSubject?: string | null
  tone?: 'formal' | 'friendly' | 'concise'
}

interface DraftResult {
  body_text: string
  body_html: string
}

// HTML → plain text (AI 입력용 — 태그/인용 제거, 토큰 절약)
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '') // script 본문 텍스트가 프롬프트에 새는 것 방지
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function useGenerateReplyDraft() {
  const { user, currentOrg } = useAuth()
  return useMutation({
    mutationFn: async (input: DraftInput): Promise<DraftResult> => {
      if (!currentOrg?.id) throw new Error('조직 정보를 불러오는 중입니다.')
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const originalBody = htmlToPlainText(input.originalBodyHtml).slice(0, 8000)
      if (!originalBody) throw new Error('답장 원문을 읽을 수 없습니다.')

      const senderName =
        (user?.user_metadata?.full_name as string | undefined) ??
        (user?.user_metadata?.name as string | undefined)

      const { data, error } = await supabase.functions.invoke('generate-reply-draft', {
        body: {
          org_id: currentOrg.id,
          contact_id: input.contactId ?? undefined,
          original_body: originalBody,
          original_subject: input.originalSubject ?? undefined,
          tone: input.tone,
          sender_name: senderName,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (error) {
        let friendly = 'AI 초안 생성에 실패했습니다.'
        try {
          const resp = (error as { context?: Response }).context
          if (resp) {
            const body = (await resp.json()) as { error?: string }
            friendly = body.error || friendly
          }
        } catch {
          friendly = error.message || friendly
        }
        throw new Error(friendly)
      }
      return data as DraftResult
    },
    onError: (e: Error) => toast.error(e.message || 'AI 초안 생성 실패'),
  })
}
