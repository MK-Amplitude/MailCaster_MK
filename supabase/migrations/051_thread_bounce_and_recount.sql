-- =============================================
-- Phase 18.4 — thread_messages bounce 추적 + 049 backfill 정정
-- ---------------------------------------------
-- 4차 감사에서 발견된 결함:
--   1) thread_messages 에 bounce 추적 컬럼이 없어 잘못된 주소 follow-up 의 bounce 가
--      pass3 에서 단순 skip 되고 UI 에 영원히 "성공" 으로 표시됨.
--   2) 049 의 dedup 후 reply_count 재계산이 reply_count > 0 인 tm 만 emit →
--      reply 가 모두 삭제된 tm 은 replied=TRUE/old reply_count 로 박제됨.
--
-- 수정:
--   1. bounced / bounced_at / bounce_reason 컬럼 추가
--   2. ALL tm 에 대해 LEFT JOIN 으로 reply_count/replied 일관 재계산
-- =============================================

-- 1) bounce 추적 컬럼
ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS bounced       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bounced_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_thread_messages_bounced
  ON mailcaster.thread_messages (org_id, bounced_at DESC)
  WHERE bounced = TRUE;

COMMENT ON COLUMN mailcaster.thread_messages.bounced IS
  '발송된 메일이 mailer-daemon 에서 bounce 됐는지. check-replies pass3 가 갱신.';
COMMENT ON COLUMN mailcaster.thread_messages.bounce_reason IS
  'bounce 메시지 본문에서 추출한 첫 줄 (또는 fallback "Bounced from <from>"). 500자 컷.';

-- 2) 049 의 backfill 정정 — ALL tm 에 대해 reply_count/replied 재계산
-- (이전 UPDATE 는 sub-query 에 reply 가 있는 tm 만 포함 → reply 모두 삭제된 tm 은 stale)
UPDATE mailcaster.thread_messages tm
   SET reply_count = COALESCE(sub.cnt, 0),
       replied     = COALESCE(sub.cnt, 0) > 0,
       replied_at  = sub.first_received_at  -- NULL 이면 NULL 로 리셋
  FROM (
    SELECT tm_inner.id AS tmid,
           cnt_sub.cnt,
           cnt_sub.first_received_at
      FROM mailcaster.thread_messages tm_inner
      LEFT JOIN (
        SELECT thread_message_id,
               COUNT(*) AS cnt,
               MIN(received_at) AS first_received_at
          FROM mailcaster.thread_message_replies
         GROUP BY thread_message_id
      ) cnt_sub ON cnt_sub.thread_message_id = tm_inner.id
  ) sub
 WHERE tm.id = sub.tmid;
