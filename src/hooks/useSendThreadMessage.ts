// 캠페인 발송 후의 1:1 후속 메일 (팔로업/회신/전달) 발송 hook.
//
// 핵심 흐름:
//   1) 토큰 + RFC Message-ID 준비 (input.rfcMessageId 있으면 fetch 스킵)
//   2) 본문에 inline 이미지 처리 + contact_id 재매핑 (to_email 기준)
//   3) thread_messages pending row insert → tmId 확보
//   4) 트래킹 픽셀 주입 → sendGmail
//   5) gmail_message_id 먼저 별도 UPDATE (retry) → status='sent' + rfc_message_id UPDATE
//   6) 실패 시 catch — Gmail 발송은 성공 (result≠null) 이면 pending 유지 + 마커 임베드,
//      Gmail 자체 실패 (result=null) 면 status='failed' 마킹. reconcile cron 이 자동 정정.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from './useAuth'
import { sendGmail, fetchMessageRfcId } from '@/lib/gmail'
import { getFreshGoogleToken } from '@/lib/googleToken'
import { extractAndInlineImages } from '@/lib/inlineImages'
import { buildThreadTrackingPixel, injectTrackingPixel } from './useSendCampaign'
import { toast } from 'sonner'

// 발송 결과 기록 UPDATE 의 재시도 설정.
// 일시적 RLS/네트워크 실패 대응. retry 모두 실패하면 reconcile cron (migration 052/054) 이
// error_message 의 [gmail_msg_id=...] 마커를 추출해 복구하므로 false-failed 박제 없음.
const UPDATE_MAX_ATTEMPTS = 3
const UPDATE_BACKOFF_BASE_MS = 500
// migration 052 의 INTERVAL '10 minutes' + migration 055 의 cron */10 = 최대 20분 안내.
const STALE_RECONCILE_NOTICE = '최대 20분 안에 자동 정정됩니다.'

export type ThreadMode = 'followup' | 'reply' | 'forward' | 'new'

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
  /**
   * 이미 알고 있는 RFC Message-ID (thread_message_replies.rfc_message_id 등).
   * 있으면 fetchMessageRfcId 호출 스킵 → Gmail API quota 절감.
   */
  inReplyToRfcMessageId?: string | null
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
      //   - 이미 알고 있는 rfc id (input.inReplyToRfcMessageId) 우선 사용 → Gmail API 호출 스킵
      //   - 없으면 inReplyToGmailMessageId 로 fetchMessageRfcId 호출
      const accessToken = await getFreshGoogleToken(user.id)
      let inReplyTo: string | null = input.inReplyToRfcMessageId ?? null
      if (!inReplyTo && input.inReplyToGmailMessageId) {
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
      try {
        if (resolvedContactId) {
          // parent contact 의 email 이 to_email 과 다르면 재 lookup (비서/대리응답 케이스).
          // parent contact 가 다른 org 에 속해 있을 수도 있으니 org 검증도 함께.
          const { data: parentContact } = await supabase
            .from('contacts')
            .select('email, org_id')
            .eq('id', resolvedContactId)
            .maybeSingle()
          if (
            !parentContact ||
            parentContact.org_id !== currentOrg.id ||
            (parentContact.email ?? '').toLowerCase() !== toEmailNorm
          ) {
            resolvedContactId = null
          }
        }
        if (!resolvedContactId) {
          // 현재 org 의 contact 중 to_email 매칭.
          // - .eq('org_id') 명시 — 사용자가 다중 org 멤버일 때 다른 org contact 선택 방지
          // - .ilike 로 대소문자 무관 매칭
          // - .limit(1) — 같은 이메일이 여러 row 면 첫 1개 (race-safe)
          const { data: foundContacts } = await supabase
            .from('contacts')
            .select('id')
            .eq('org_id', currentOrg.id)
            .ilike('email', toEmailNorm)
            .limit(1)
          if (foundContacts && foundContacts.length > 0) {
            resolvedContactId = (foundContacts[0] as { id: string }).id
          }
        }
      } catch (e) {
        // contact lookup 실패해도 발송은 진행 — contact_id 만 NULL.
        console.warn('[useSendThreadMessage] contact lookup failed:', e)
        resolvedContactId = null
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
      // sendGmail 성공 여부를 catch 에서 판별하기 위해 result 를 try 밖으로 노출.
      // - result 가 채워졌으면 = Gmail 발송 성공 (메일이 이미 받는 사람에게 갔음).
      //   이후 DB UPDATE 가 실패해도 status='failed' 로 박제하면 안 됨 — 실제로는 sent.
      //   reconcile cron (migration 052) 의 branch 1 이 gmail_message_id 가 있는 pending row
      //   를 sent 로 정정하므로, status 를 손대지 않고 pending 으로 두는 게 정합.
      // - result 가 null 이면 = sendGmail 자체가 실패. status='failed' 로 마킹 OK.
      let result: { id: string; threadId: string } | null = null
      try {
        result = await sendGmail({
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

        // 발송 성공 — 즉시 gmail_message_id / gmail_thread_id 부터 먼저 UPDATE.
        // 성공 시 reconcile cron 의 branch 1 (gmail_message_id 있는 pending → sent) 이 정상 동작.
        // retry 모두 실패하면 throw 메시지에 [gmail_msg_id=XXX] 마커 임베드 → migration 054 의
        // marker recovery branch 가 추출해서 gmail_message_id 복구 + sent 정정 (false-failed 회피).
        let firstUpdateOk = false
        let firstUpdateErr: string | null = null
        for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, UPDATE_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)),
            )
          }
          const r = await supabase
            .from('thread_messages')
            .update({
              gmail_message_id: result.id,
              gmail_thread_id: result.threadId,
            })
            .eq('id', tmId)
          if (!r.error) {
            firstUpdateOk = true
            break
          }
          firstUpdateErr = r.error.message
        }
        if (!firstUpdateOk) {
          throw new Error(
            `Gmail 발송은 완료됐으나 시스템 기록 실패 (${firstUpdateErr ?? 'unknown'}).` +
              ` ${STALE_RECONCILE_NOTICE}` +
              ` [gmail_msg_id=${result.id}]`,
          )
        }

        // RFC Message-ID 조회 — A 답장 시 In-Reply-To 매칭용. best-effort.
        let ownRfcMessageId: string | null = null
        try {
          ownRfcMessageId = await fetchMessageRfcId(accessToken, result.id)
        } catch (e) {
          // 비치명적 — rfc_message_id 가 NULL 이어도 pass3 의 chronological fallback 동작
          console.warn('[useSendThreadMessage] failed to fetch own RFC Message-ID:', e)
        }

        // 최종 상태 — status='sent' + sent_at + rfc_message_id
        await supabase
          .from('thread_messages')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            rfc_message_id: ownRfcMessageId,
          })
          .eq('id', tmId)
        return { tmId, gmailMessageId: result.id, gmailThreadId: result.threadId }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // sendGmail 성공 여부로 분기:
        // - result !== null = Gmail 발송 성공, 이후 DB 단계에서 실패. pending 유지 → reconcile cron 이 정정.
        // - result === null = sendGmail 자체 실패. failed 마킹.
        //
        // catch 안의 UPDATE 들도 retry 적용 — firstUpdate 가 막 실패한 직후라 같은 원인
        // (RLS / 인증 만료 / 네트워크) 으로 재실패할 가능성이 큼. 특히 result !== null 분기는
        // error_message 에 [gmail_msg_id=XXX] 마커가 들어가야 reconcile cron 이 복구 가능 →
        // 이 UPDATE 가 실패하면 마커가 휘발돼 false-failed 박제 (10차 감사 C1).
        const tryUpdate = async (
          payload: { status?: 'failed'; error_message: string },
        ): Promise<boolean> => {
          for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) {
              await new Promise((r) =>
                setTimeout(r, UPDATE_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)),
              )
            }
            const r = await supabase
              .from('thread_messages')
              .update(payload)
              .eq('id', tmId)
            if (!r.error) return true
          }
          return false
        }

        if (result === null) {
          await tryUpdate({ status: 'failed', error_message: msg })
        } else {
          // pending 유지 + error_message (마커 포함) 기록 → reconcile cron 이 마커 추출 후 정정.
          await tryUpdate({ error_message: msg })
        }
        throw e
      }
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['thread_messages'] })
      if (vars.recipientId) {
        qc.invalidateQueries({ queryKey: ['campaigns', 'recipients'] })
      }
      // 발송 후 메일 히스토리 / 보낸편지함 / 대시보드 KPI 즉시 반영.
      // (특히 contact_mail_history 는 키 불일치 + 0건 폴링 미동작으로 영구 미반영되던 문제 — prefix invalidate)
      qc.invalidateQueries({ queryKey: ['contact_mail_history'] })
      qc.invalidateQueries({ queryKey: ['outbound-feed'] })
      qc.invalidateQueries({ queryKey: ['inbox-stats'] })
      const label =
        vars.mode === 'followup'
          ? '팔로업'
          : vars.mode === 'reply'
            ? '회신'
            : vars.mode === 'forward'
              ? '전달'
              : '메일'
      toast.success(`${label} 발송 완료`)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : '발송 실패')
    },
  })
}
