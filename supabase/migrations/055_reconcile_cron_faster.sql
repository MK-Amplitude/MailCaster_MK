-- =============================================
-- Phase 18.8 — reconcile cron 주기 단축
-- ---------------------------------------------
-- 10차 감사 m1: 052 의 cron 이 매시 17분만 실행 → pending 10분 timeout 후 최대 1시간
-- 더 기다려야 함. 토스트 안내 "약 10분 후 자동 정정" 와 실제 동작이 불일치.
--
-- 단축: 매시 17분 → 매 10분 (*/10 * * * *). pending timeout 10분 + cron 10분 주기 =
-- 최대 약 20분 후 정정. 토스트 안내와 합리적 일치.
-- =============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-reconcile-thread-pending') THEN
    PERFORM cron.unschedule('mailcaster-reconcile-thread-pending');
  END IF;
END
$$;

SELECT cron.schedule(
  'mailcaster-reconcile-thread-pending',
  '*/10 * * * *',  -- 매 10분
  $$SELECT mailcaster.reconcile_stale_thread_messages()$$
);
