-- =============================================
-- Phase 18.7 — reconcile cron 에 marker recovery branch 추가
-- ---------------------------------------------
-- 9차 감사 발견 C1 (회귀):
--   useSendThreadMessage 의 firstUpdate retry (3회) 가 모두 실패하면
--   gmail_message_id 가 DB 에 못 들어가고, 052 의 branch 2 (gmail_message_id NULL → failed)
--   가 false-failed 박제 → 사용자 재발송 시 중복.
--
-- 해결:
--   useSendThreadMessage 가 throw 직전 error_message 에 [gmail_msg_id=XXX] 마커 임베드.
--   reconcile cron 이 그 마커를 추출해 gmail_message_id 복구 + status='sent' 정정.
--   (정확한 패턴이라 false-positive 위험 낮음 — error_message 에 사용자 입력은 없음)
-- =============================================

-- 기존 시그니처 (fixed_sent, fixed_failed) 와 RETURN type 이 달라지므로 DROP 후 CREATE.
DROP FUNCTION IF EXISTS mailcaster.reconcile_stale_thread_messages();

CREATE FUNCTION mailcaster.reconcile_stale_thread_messages()
RETURNS TABLE(fixed_sent INTEGER, fixed_failed INTEGER, fixed_marker_recovered INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_sent INTEGER := 0;
  v_failed INTEGER := 0;
  v_marker INTEGER := 0;
BEGIN
  -- branch 1: gmail_message_id 있고 10분 이상 pending → 사실상 발송됐는데 확인만 누락. sent 로.
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

  -- branch 1.5 (NEW): error_message 에 [gmail_msg_id=XXX] 마커 있으면 복구 후 sent 처리.
  -- useSendThreadMessage 가 firstUpdate retry 모두 실패 시 throw 메시지에 임베드.
  -- 마커 형식: [gmail_msg_id=<gmail internal message id>]
  WITH recovered AS (
    UPDATE mailcaster.thread_messages
       SET gmail_message_id = substring(error_message FROM '\[gmail_msg_id=([^\]]+)\]'),
           status = 'sent',
           sent_at = COALESCE(sent_at, created_at)
     WHERE status = 'pending'
       AND gmail_message_id IS NULL
       AND error_message ~ '\[gmail_msg_id=[^\]]+\]'
       AND created_at < NOW() - INTERVAL '10 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_marker FROM recovered;

  -- branch 2: gmail_message_id NULL + 마커도 없으면 진짜 발송 실패. failed.
  WITH updated AS (
    UPDATE mailcaster.thread_messages
       SET status = 'failed',
           error_message = COALESCE(error_message, '발송 결과 확인 실패 (10분 timeout)')
     WHERE status = 'pending'
       AND gmail_message_id IS NULL
       AND (error_message IS NULL OR error_message !~ '\[gmail_msg_id=[^\]]+\]')
       AND created_at < NOW() - INTERVAL '10 minutes'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_failed FROM updated;

  RETURN QUERY SELECT v_sent, v_failed, v_marker;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.reconcile_stale_thread_messages() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.reconcile_stale_thread_messages() TO service_role;

COMMENT ON FUNCTION mailcaster.reconcile_stale_thread_messages() IS
  '10분 이상 pending 인 thread_messages 정리. (1) gmail_message_id 있으면 sent, (2) error_message 에 [gmail_msg_id=XXX] 마커 있으면 복구 후 sent, (3) 둘 다 없으면 failed.';
