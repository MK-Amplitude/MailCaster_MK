-- =============================================
-- Phase 11.1 — thread 활동 메타 추적
-- ---------------------------------------------
-- 기존: replied=true/false 만 기록. "고객이 답장했나" 만 알 수 있음.
-- 추가: 그 thread 의 가장 최근 활동 시각 + 마지막 메시지가 누구 발인지.
--
-- 영업 가치:
--   - "내가 답장 안 한 응답" 자동 식별 (last_message_from_me=false)
--   - thread 의 깊이 (대화 횟수)
--   - back-and-forth 적극도
--
-- 컬럼:
--   last_thread_message_at        TIMESTAMPTZ — 그 thread 에서 가장 최근 메시지 시각
--   last_thread_message_from_me   BOOLEAN     — 마지막 메시지가 내가 보낸 건지
--   thread_message_count          INT         — thread 안 메시지 총 개수 (내 + 상대)
--
-- 갱신 정책:
--   - check-replies cron 이 답장 처음 감지 시 한 번 채움 (snapshot)
--   - 별도 second-pass 가 replied=true && last_message_from_me=false 행을 cooldown
--     (예: 6시간) 으로 재방문해 갱신
-- =============================================

ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS last_thread_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_thread_message_from_me BOOLEAN,
  ADD COLUMN IF NOT EXISTS thread_message_count INT;

-- "내 답장 대기 중" 인사이트용 partial index — actionable 행만.
CREATE INDEX IF NOT EXISTS idx_recipients_my_response_pending
  ON mailcaster.recipients (campaign_id, last_thread_message_at DESC)
  WHERE replied = TRUE AND last_thread_message_from_me = FALSE;

-- second-pass 큐 인덱스 — replied=true 인 행을 cooldown 으로 round-robin 할 때.
CREATE INDEX IF NOT EXISTS idx_recipients_thread_recheck
  ON mailcaster.recipients (last_reply_check_at NULLS FIRST)
  WHERE replied = TRUE AND gmail_thread_id IS NOT NULL;

COMMENT ON COLUMN mailcaster.recipients.last_thread_message_at IS
  'thread 의 가장 최근 메시지 시각. check-replies cron 이 갱신.';
COMMENT ON COLUMN mailcaster.recipients.last_thread_message_from_me IS
  'thread 의 마지막 메시지를 내가(캠페인 발신자) 보냈는지. false=고객 답장이 마지막=내 답장 대기.';
COMMENT ON COLUMN mailcaster.recipients.thread_message_count IS
  'thread 의 메시지 총 개수 (내 + 상대 합산).';
