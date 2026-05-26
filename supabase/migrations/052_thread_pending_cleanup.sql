-- =============================================
-- Phase 18.5 — pending thread_messages 정리
-- ---------------------------------------------
-- 4차 감사에서 발견된 결함:
--   useSendThreadMessage 가 sendGmail 성공 후 status='sent' UPDATE 도중
--   네트워크/페이지 leave 등으로 실패하면 thread_messages 가 pending 으로 영원 잔존.
--   → 사용자에게 stuck 으로 보이고 분석 통계도 왜곡.
--
-- 대응:
--   * pg_cron 이 1시간마다 "10분 이상 pending" 인 thread_messages 를 'failed' 로 정리.
--     gmail_message_id 가 채워져 있으면 사실상 발송은 됐지만 confirmation 누락 —
--     status='sent' 로 추정 정정 (sent_at 도 created_at 으로 fallback).
--   * 그 외 (gmail_message_id NULL, 10분 경과) — 'failed' + error_message 명시.
-- =============================================

-- RPC 작성 — service_role 만 호출. 작은 함수라 pg_cron 에서 직접 SQL 도 가능하지만
-- 함수로 두면 향후 admin UI 에서 즉시 트리거 가능.
CREATE OR REPLACE FUNCTION mailcaster.reconcile_stale_thread_messages()
RETURNS TABLE(fixed_sent INTEGER, fixed_failed INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_sent INTEGER := 0;
  v_failed INTEGER := 0;
BEGIN
  -- 1) gmail_message_id 가 있고 10분 이상 pending → 사실상 발송됐는데 확인만 누락. sent 로 추정.
  WITH updated AS (
    UPDATE mailcaster.thread_messages
       SET status = 'sent',
           sent_at = COALESCE(sent_at, created_at)
     WHERE status = 'pending'
       AND gmail_message_id IS NOT NULL
       AND created_at < NOW() - INTERVAL '10 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_sent FROM updated;

  -- 2) gmail_message_id 가 NULL 이고 10분 이상 pending → 발송 자체가 실패. failed.
  WITH updated AS (
    UPDATE mailcaster.thread_messages
       SET status = 'failed',
           error_message = COALESCE(error_message, '발송 결과 확인 실패 (10분 timeout)')
     WHERE status = 'pending'
       AND gmail_message_id IS NULL
       AND created_at < NOW() - INTERVAL '10 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_failed FROM updated;

  RETURN QUERY SELECT v_sent, v_failed;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.reconcile_stale_thread_messages() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.reconcile_stale_thread_messages() TO service_role;

COMMENT ON FUNCTION mailcaster.reconcile_stale_thread_messages() IS
  '10분 이상 pending 인 thread_messages 정리. gmail_message_id 있으면 sent 로, 없으면 failed 로.';

-- pg_cron — 1시간 주기 (pending stuck 은 드무니 자주 안 돌려도 OK)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-reconcile-thread-pending') THEN
    PERFORM cron.unschedule('mailcaster-reconcile-thread-pending');
  END IF;
END
$$;

SELECT cron.schedule(
  'mailcaster-reconcile-thread-pending',
  '17 * * * *',  -- 매시 17분
  $$SELECT mailcaster.reconcile_stale_thread_messages()$$
);
