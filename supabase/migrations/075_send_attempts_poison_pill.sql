-- =============================================
-- 075 — 발송 재시도 상한 (poison-pill 가드) + 고착 캠페인 데이터 복구 + cron 완화
-- ---------------------------------------------
-- 배경:
--   첨부가 큰 캠페인이 Edge Function 메모리 한도(WORKER_RESOURCE_LIMIT)로
--   크래시하면, orphan 복구 로직이 매분 같은 캠페인을 다시 집어 → 다시 크래시
--   하는 무한 루프가 됨. 이 루프가 수 시간 지속되면 nano 급 DB 의 CPU 크레딧을
--   소진시켜 프로젝트 전체(Auth 포함)가 Unhealthy 로 전락 (2026-08-31 실사고).
--
-- 조치:
--   1) campaigns.send_attempts — 서버 발송 시도 횟수. 락 획득 시점에 증가시키므로
--      이후 크래시해도 카운트가 남는다 (crash-safe). Edge Function 이 5회 초과 시
--      'failed' 로 내려 루프를 끊는다.
--   2) 데이터 복구 — 현재 고착돼 루프를 돌고 있는 캠페인을 failed 로 내리고
--      미발송 수신자를 pending 으로 되돌림 (UI 의 클라이언트 발송으로 재개 가능).
--   3) cron 완화 — 매분 돌던 send-scheduled-campaigns / process-sequences 를
--      각각 2분/5분 주기로. ("지금 발송" 은 클라이언트가 함수를 즉시 킥하므로
--      cron 은 폴백일 뿐 — 체감 지연 없음. 시퀀스는 일 단위 cadence 라 5분이면 충분.)
-- =============================================

-- ------------------------------------------------------------
-- 1. send_attempts 컬럼
-- ------------------------------------------------------------
ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS send_attempts INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN mailcaster.campaigns.send_attempts IS
  '서버 발송 락 획득 횟수. 크래시 루프 차단용 — 5회 초과 시 Edge Function 이 failed 처리. 발송 성공/재개 시 0 으로 리셋.';

-- ------------------------------------------------------------
-- 2. 고착 캠페인 데이터 복구 (one-shot)
--    - 미발송 수신자(sending + gmail_message_id NULL) → pending
--    - 'sending' 캠페인 전부 + 30분 이상 지난 'scheduled' → failed
--      (크래시 루프가 매분 sending_started_at 을 갱신하므로 시각 기준으로는
--       poison 캠페인을 구분할 수 없음 — 마이그레이션 시점의 'sending' 은
--       루프 중이거나 죽은 실행뿐이라 일괄 정리가 안전)
-- ------------------------------------------------------------
UPDATE mailcaster.recipients r
SET status = 'pending'
FROM mailcaster.campaigns c
WHERE r.campaign_id = c.id
  AND c.status = 'sending'
  AND r.status = 'sending'
  AND r.gmail_message_id IS NULL;

UPDATE mailcaster.campaigns
SET status = 'failed',
    scheduled_at = NULL,
    sending_started_at = NULL,
    last_processed_recipient_id = NULL,
    send_attempts = 0
WHERE status = 'sending'
   OR (status = 'scheduled' AND scheduled_at < now() - INTERVAL '30 minutes');

-- ------------------------------------------------------------
-- 3. cron 주기 완화
-- ------------------------------------------------------------
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-send-scheduled-campaigns') THEN
    PERFORM cron.unschedule('mailcaster-send-scheduled-campaigns');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-process-sequences') THEN
    PERFORM cron.unschedule('mailcaster-process-sequences');
  END IF;
END
$unsched$;

SELECT cron.schedule(
  'mailcaster-send-scheduled-campaigns',
  '*/2 * * * *',
  $cronbody$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'mailcaster_project_url'
      ) || '/functions/v1/send-scheduled-campaigns',
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

SELECT cron.schedule(
  'mailcaster-process-sequences',
  '*/5 * * * *',
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
