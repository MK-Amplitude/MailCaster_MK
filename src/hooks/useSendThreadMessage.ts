// 캠페인 발송 후의 1:1 후속 메일 (팔로업/회신/전달) 발송 hook.
//
// 흐름:
//   1) profile 의 google_refresh_token 으로 access_token 획득
//   2) (있으면) 원본 메시지의 RFC Message-ID 조회
//   3) thread_messages 에 pending 행 insert
//   4) Gmail API 로 발송 (threadId + In-Reply-To 헤더)
//   5) 성공 시 thread_messages row 업데이트 (sent + gmail_message_id)
//   6) 실패 시 status='failed' + error_message

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { sendGmail, fetchMessageRfcId } from '@/lib/gmail'
import { getFreshGoogleToken } from '@/lib/googleToken'
import { extractAndInlineImages } from '@/lib/inlineImages'
import { buildThreadTrackingPixel, injectTrackingPixel } from './useSendCampaign'
import { toast } from 'sonner'

export type ThreadMode = 'followup' | 'reply' | 'forward'

export interface SendThreadInput {
  mode: ThreadMode
  toEmail: string
  toName?: string | null
  subject: string
  html: string
  /** 같은 thread 안에 끼우려면 (followup/reply) — 원본 발송의 gmail_thread_id. forward 는 보통 NULL. */
  threadId?: string | null
  /**
   * 답장 대상 원본의 Gmail 내부 message id (recipients.gmail_message_id 등).
   * 이 함수가 직접 fetchMessageRfcId 로 RFC Message-ID 를 가져와 In-Reply-To 에 넣는다.
   */
  inReplyToGmailMessageId?: string | null
  /** thread_messages 에 기록할 연관 메타 */
  campaignId?: string | null
  recipientId?: string | null
  contactId?: string | null
  cc?: string[]
  bcc?: string[]
}

export function useSendThreadMessage() {
  const qc = useQueryClient()
  const { user, currentOrg } = useAuth()

  return useMutation({
    mutationFn: async (input: SendThreadInput) => {
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!currentOrg) throw new Error('조직 정보가 없습니다.')
      if (!input.toEmail.trim()) throw new Error('받는 사람 이메일이 필요합니다.')
      if (!input.subject.trim()) throw new Error('제목을 입력하세요.')
      if (!input.html.trim()) throw new Error('본문을 입력하세요.')

      // 1) sender profile
      const { data: profile, error: pErr } = await supabase
        .from('profiles')
        .select('email, display_name, default_sender_name')
        .eq('id', user.id)
        .single()
      if (pErr) throw pErr
      const fromEmail = profile?.email
      if (!fromEmail) throw new Error('프로필의 이메일이 비어있습니다.')
      const fromName =
        (profile?.default_sender_name as string | null) ??
        (profile?.display_name as string | null) ??
        ''
      const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail

      // 2) access_token + RFC Message-ID (있으면)
      const accessToken = await getFreshGoogleToken(user.id)
      let inReplyTo: string | null = null
      if (input.inReplyToGmailMessageId) {
        inReplyTo = await fetchMessageRfcId(
          accessToken,
          input.inReplyToGmailMessageId,
        )
      }

      // 3) 본문 inline 이미지 처리 — Storage URL 을 CID embed (다른 발송 경로와 동일)
      const { html: bodyWithCids, images: inlineImages } =
        await extractAndInlineImages(input.html)

      // 3.5) contact_id 재매핑 — to_email 이 기존 contact 가 아닐 수도 있음 (비서/대리응답자가 회신).
      //      input.contactId 는 parent thread_message 의 것이 그대로 넘어왔으므로, to_email 과
      //      일치하는 contact 가 있으면 그쪽으로 교체. 없으면 NULL (잘못된 contact 가리키는 것보다 깨끗).
      const toEmailNorm = input.toEmail.trim().toLowerCase()
      let resolvedContactId: string | null = input.contactId ?? null
      if (resolvedContactId) {
        // parent contact 의 email 이 to_email 과 다르면 재 lookup (비서/대리응답 케이스)
        const { data: parentContact } = await supabase
          .from('contacts')
          .select('email')
          .eq('id', resolvedContactId)
          .maybeSingle()
        if (!parentContact || (parentContact.email ?? '').toLowerCase() !== toEmailNorm) {
          resolvedContactId = null
        }
      }
      if (!resolvedContactId) {
        // org 내 contact 중 to_email 매칭. RLS 가 org 필터링.
        // - ilike 로 대소문자 무관 매칭 (contacts.email 정규화가 일관 안 될 수 있음)
        // - limit(1).maybeSingle() — 같은 이메일이 여러 contact 인 경우 throw 방지
        const { data: foundContacts } = await supabase
          .from('contacts')
          .select('id')
          .ilike('email', toEmailNorm)
          .limit(1)
        if (foundContacts && foundContacts.length > 0) {
          resolvedContactId = (foundContacts[0] as { id: string }).id
        }
      }

      // 4) thread_messages pending 행 insert
      const { data: tmRow, error: tmErr } = await supabase
        .from('thread_messages')
        .insert({
          org_id: currentOrg.id,
          user_id: user.id,
          campaign_id: input.campaignId ?? null,
          recipient_id: input.recipientId ?? null,
          contact_id: resolvedContactId,
          mode: input.mode,
          to_email: input.toEmail.trim(),
          to_name: input.toName ?? null,
          cc: input.cc ?? [],
          bcc: input.bcc ?? [],
          subject: input.subject,
          body_html: bodyWithCids,
          gmail_thread_id: input.threadId ?? null,
          in_reply_to_message_id: inReplyTo,
          status: 'pending',
        })
        .select('id')
        .single()
      if (tmErr) throw tmErr
      const tmId = (tmRow as { id: string }).id

      // 5) 트래킹 픽셀 주입 — tmId 가 있어야 하므로 insert 이후에 처리
      const htmlWithPixel = injectTrackingPixel(bodyWithCids, buildThreadTrackingPixel(tmId))

      // 6) 발송
      try {
        const result = await sendGmail({
          accessToken,
          from,
          to: input.toEmail,
          toName: input.toName,
          subject: input.subject,
          html: htmlWithPixel,
          cc: input.cc && input.cc.length > 0 ? input.cc : undefined,
          bcc: input.bcc && input.bcc.length > 0 ? input.bcc : undefined,
          threadId: input.threadId ?? undefined,
          inReplyTo: inReplyTo ?? undefined,
          inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
        })
        // 우리가 보낸 메시지의 RFC Message-ID 를 조회 — A 가 답장 시 In-Reply-To 헤더에 들어오는 값.
        // check-replies pass3 가 이 값을 보고 어느 thread_message 의 회신인지 정확히 매핑.
        // fetch 실패해도 발송은 성공이므로 best-effort.
        let ownRfcMessageId: string | null = null
        try {
          ownRfcMessageId = await fetchMessageRfcId(accessToken, result.id)
        } catch (e) {
          // 비치명적 — rfc_message_id 가 NULL 이어도 pass3 가 fallback 으로 매핑함
          console.warn('[useSendThreadMessage] failed to fetch own RFC Message-ID:', e)
        }

        // 성공 — 결과 기록
        await supabase
          .from('thread_messages')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            gmail_message_id: result.id,
            gmail_thread_id: result.threadId, // 신규 thread 인 경우 Gmail 이 새로 발급한 id
            rfc_message_id: ownRfcMessageId,
          })
          .eq('id', tmId)
        return { tmId, gmailMessageId: result.id, gmailThreadId: result.threadId }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await supabase
          .from('thread_messages')
          .update({ status: 'failed', error_message: msg })
          .eq('id', tmId)
        throw e
      }
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['thread_messages'] })
      if (vars.recipientId) {
        qc.invalidateQueries({ queryKey: ['campaigns', 'recipients'] })
      }
      const label =
        vars.mode === 'followup' ? '팔로업' : vars.mode === 'reply' ? '회신' : '전달'
      toast.success(`${label} 발송 완료`)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '발송 실패')
    },
  })
}
