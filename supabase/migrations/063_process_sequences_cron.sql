-- =============================================
-- 고도화 Tier 1-B — process-sequences cron 스케줄
-- ---------------------------------------------
-- 시퀀스 due enrollment 를 매 분 발송 (send-scheduled-campaigns 와 동일 vault 패턴).
-- 함수 내부에서 claim_due_sequence_steps(FOR UPDATE SKIP LOCKED + 15분 hold)로
-- 동시 실행/중복 발송을 방지하므로 매 분 호출 안전.
-- =============================================

DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-process-sequences') THEN
    PERFORM cron.unschedule('mailcaster-process-sequences');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-process-sequences',
  '* * * * *',
  $cronbody$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'mailcaster_project_url'
      ) || '/functions/v1/process-sequences',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
            FROM vault.decrypted_secrets
           WHERE name = 'mailcaster_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cronbody$
);
