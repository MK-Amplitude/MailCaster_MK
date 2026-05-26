-- =============================================
-- Phase 18.3 — 발송 메시지의 RFC Message-ID 저장
-- ---------------------------------------------
-- 3차 감사에서 발견된 결함:
--   * In-Reply-To 매칭이 사실상 동작 안 함.
--     A 가 우리 thread_message 에 답장할 때 In-Reply-To 헤더에 들어가는 것은
--     "우리가 보낸 thread_message 의 RFC Message-ID" 인데, 우리는 그 값을 저장 안 함.
--     기존 in_reply_to_message_id 컬럼은 "우리가 응답한 원본의 RFC Message-ID" 라 의미가 다름.
--
-- 추가:
--   thread_messages.rfc_message_id  TEXT  — 우리가 보낸 메시지의 RFC 2822 Message-ID 헤더값.
--   useSendThreadMessage 가 sendGmail 직후 fetchMessageRfcId 로 가져와 저장.
--   check-replies pass3 가 In-Reply-To / References 비교 후보에 추가 → 정확한 tm 매핑.
-- =============================================

ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;

COMMENT ON COLUMN mailcaster.thread_messages.rfc_message_id IS
  '우리가 보낸 메시지의 RFC 2822 Message-ID 헤더값. A 가 답장할 때 In-Reply-To 에 넣는 값과 매칭하기 위함.';

-- pass3 의 In-Reply-To 매칭용 인덱스 — 단일 컬럼 lookup
CREATE INDEX IF NOT EXISTS idx_thread_messages_rfc_message_id
  ON mailcaster.thread_messages (rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;
