-- =============================================
-- 고도화 Tier 4 (안전 부분) — cron 스태거 + sent-thread 조회 인덱스
-- ---------------------------------------------
-- 1) Gmail 폴링 cron 부하 분산:
--    check-inbox(*/5 → 0,5,10..) 와 check-replies(*/5 → 0,5,10..) 가 같은 분에
--    동시에 Gmail 을 두드린다. check-replies 를 2분 오프셋(2-59/5 → 2,7,12..)으로
--    옮겨 분당 Gmail 호출 burst 를 완화. (cron.alter_job 으로 schedule 만 변경 —
--    http_post body 는 그대로 두어 안전)
--
-- 2) sent thread_messages 조회 인덱스:
--    inbox_stats(060) 의 미응답 NOT EXISTS 와 useOurRepliesByThread 가
--    status='sent' + gmail_thread_id + sent_at 로 자주 조회한다. 부분 인덱스로 가속.
--
-- 주의: Gmail History API 전환/배치화 등 폴링 구조 개편은 라이브 Gmail 검증이 필요해
--       별도 작업으로 분리. 본 마이그레이션은 동작 변경 없는 안전한 최적화만 포함.
-- =============================================

-- 1) check-replies cron 2분 오프셋 (body 불변, schedule 만 변경)
DO $$
DECLARE
  v_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'mailcaster-check-replies';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, schedule => '2-59/5 * * * *');
  END IF;
END
$$;

-- 2) sent thread 조회 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_thread_messages_sent_thread
  ON mailcaster.thread_messages (gmail_thread_id, sent_at)
  WHERE status = 'sent' AND gmail_thread_id IS NOT NULL;
