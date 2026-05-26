-- =============================================
-- Phase 18.6 — pass3 폴링 큐에서 bounced 제외
-- ---------------------------------------------
-- 6차 감사 m2: idx_thread_messages_reply_recheck 의 partial index 가
-- bounced 상태를 제외하지 않아 bounce 된 tm 도 cooldown 마다 다시 폴링됨 →
-- Gmail quota 낭비. 인덱스를 재작성.
-- =============================================

DROP INDEX IF EXISTS mailcaster.idx_thread_messages_reply_recheck;

CREATE INDEX IF NOT EXISTS idx_thread_messages_reply_recheck
  ON mailcaster.thread_messages (last_reply_check_at NULLS FIRST)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL AND bounced = FALSE;

COMMENT ON INDEX mailcaster.idx_thread_messages_reply_recheck IS
  'check-replies cron pass3 의 cooldown 기반 polling 큐. bounced 제외 — Gmail quota 절감.';
