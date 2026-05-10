// 개인화 발송 — AI 가 사람마다 살짝 다른 본문을 만들고, 그것을 그대로 캠페인으로 발송.
// 두 단계로 나눔:
//   1) useGeneratePersonalizedBodies — 미리보기용 생성 (edge function 호출만)
//   2) useCreatePersonalizedCampaign  — 검토 끝난 결과로 campaign + recipients(overrides) 생성

import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'

export interface GeneratedBody {
  contact_id: string
  name: string | null
  email: string
  subject: string
  body_html: string
}

interface GenerateInput {
  contactIds: string[]
  intent: string
  tone?: 'formal' | 'friendly' | 'concise'
  signatureHtml?: string
  senderName?: string
}

export function useGeneratePersonalizedBodies() {
  const { currentOrg } = useAuth()
  return useMutation({
    mutationFn: async (input: GenerateInput): Promise<GeneratedBody[]> => {
      if (!currentOrg) throw new Error('조직 정보가 없습니다.')

      // suggest-contact-group 와 동일 패턴 — 세션 JWT 명시 전달.
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('로그인이 필요합니다.')

      const { data, error } = await supabase.functions.invoke(
        'generate-personalized-bodies',
        {
          body: {
            contact_ids: input.contactIds,
            intent: input.intent,
            org_id: currentOrg.id,
            tone: input.tone,
            signature_html: input.signatureHtml,
            sender_name: input.senderName,
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
      if (error) {
        let friendly = 'AI 본문 생성에 실패했습니다.'
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
      const r = data as { results: GeneratedBody[] }
      return r.results
    },
  })
}

interface CreateInput {
  /** 캠페인 표시 이름 — 보통 intent 앞부분 */
  name: string
  /** 검토 끝난 사람별 결과 */
  bodies: GeneratedBody[]
}

/**
 * AI 결과를 그대로 발송 가능한 캠페인으로 저장.
 *   - campaigns: subject/body_html 은 비움. 진실은 recipients 의 override 에.
 *   - recipients: contact 별 1행 + subject_override / body_html_override 저장
 */
export function useCreatePersonalizedCampaign() {
  const { user, currentOrg } = useAuth()
  return useMutation({
    mutationFn: async (input: CreateInput): Promise<{ campaign_id: string }> => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('조직 정보가 없습니다.')

      // 1) 캠페인 row — 본문/제목 비어 있어도 추후 detail page 에서 발송 가능.
      const { data: cmp, error: cErr } = await supabase
        .from('campaigns')
         
        .insert({
          user_id: user.id,
          org_id: currentOrg.id,
          name: input.name,
          subject: '',
          body_html: '',
          status: 'draft',
          send_mode: 'individual',
          enable_open_tracking: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        .select('id')
        .single()
      if (cErr) throw cErr
      const campaignId = cmp!.id as string

      // 2) recipients — contact 별로 override 저장
      // contact_id 와 email 을 매핑하기 위해 contacts 테이블 조회
      const contactIds = input.bodies.map((b) => b.contact_id)
      const { data: contacts, error: ctErr } = await supabase
        .from('contacts')
        .select('id, name, email, variables')
        .in('id', contactIds)
      if (ctErr) throw ctErr
      const cmap = new Map(
        (contacts ?? []).map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => [c.id as string, c]
        )
      )

      const rows = input.bodies
        .map((b) => {
          const c = cmap.get(b.contact_id)
          if (!c) return null
          return {
            campaign_id: campaignId,
            contact_id: b.contact_id,
            email: c.email,
            name: c.name ?? null,
            variables: c.variables ?? {},
            status: 'pending',
            subject_override: b.subject,
            body_html_override: b.body_html,
          }
        })
        .filter(Boolean)

      const { error: rErr } = await supabase
        .from('recipients')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(rows as any)
      if (rErr) throw rErr

      // 3) 캠페인 카운트 컬럼 업데이트 (UI 일관성)
      await supabase
        .from('campaigns')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ total_count: rows.length } as any)
        .eq('id', campaignId)

      return { campaign_id: campaignId }
    },
  })
}
