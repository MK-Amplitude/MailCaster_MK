-- ============================================================
-- 008_scheduled_send_cron.sql
-- ------------------------------------------------------------
-- 매 분마다 status='scheduled' AND scheduled_at<=now() 인 캠페인을
-- 자동 발송하기 위한 pg_cron job 을 등록한다.
--
-- 사전 요구 사항 (006 과 동일 — 이미 해뒀다면 재수행 불필요):
--   1) Database → Extensions 에서 pg_cron, pg_net 토글 ON  (006 에서 이미 처리)
--   2) Edge Functions → Secrets 에 CRON_SECRET 저장        (006 에서 이미 처리)
--   3) vault.create_secret('<project url>', 'mailcaster_project_url')  ← 006 에서 완료됨
--      vault.create_secret('<CRON_SECRET>',  'mailcaster_cron_secret') ← 006 에서 완료됨
--
-- 보안:
--   - edge function 내부에서 Authorization 헤더 로 CRON_SECRET 을 검증한다.
--   - profiles.google_refresh_token 은 service_role 로만 접근 가능.
--
-- 변경 이력:
--   v1 (2026-04) — 최초 도입. 1분 간격 포문.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ------------------------------------------------------------
-- 인덱스 — cron 이 매 분마다 스캔하므로 status+scheduled_at 복합 인덱스 유리.
--   partial index 로 'scheduled' 행만 담아 크기 최소화.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_due
  ON mailcaster.campaigns (scheduled_at)
  WHERE status = 'scheduled';

-- ------------------------------------------------------------
-- 기존 job 이 있으면 제거 (re-run 안전)
-- ------------------------------------------------------------
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-send-scheduled-campaigns') THEN
    PERFORM cron.unschedule('mailcaster-send-scheduled-campaigns');
  END IF;
END
$unsched$;

-- ------------------------------------------------------------
-- cron job — 매 분 실행 (scheduled_at 해상도가 분 단위면 충분)
-- 더 촘촘하게(10초) 하려면 '* * * * *' 대신 별도 초급 스케줄러가 필요
-- ------------------------------------------------------------
SELECT cron.schedule(
  'mailcaster-send-scheduled-campaigns',
  '* * * * *',
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
      timeout_milliseconds := 55000  -- 1분 주기보다 짧게 — 중복 호출 방지
    );
  $cronbody$
);

-- ------------------------------------------------------------
-- 참고: 디버깅
-- ------------------------------------------------------------
-- 수동 실행 (006 와 동일 — url 만 /send-scheduled-campaigns 로 교체):
-- SELECT net.http_post(
--   url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mailcaster_project_url')
--          || '/functions/v1/send-scheduled-campaigns',
--   headers := jsonb_build_object(
--     'Content-Type', 'application/json',
--     'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mailcaster_cron_secret')
--   ),
--   body := '{}'::jsonb,
--   timeout_milliseconds := 55000
-- );
--
-- cron 기록:
-- SELECT jobname, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--  WHERE jobname = 'mailcaster-send-scheduled-campaigns'
--  ORDER BY start_time DESC
--  LIMIT 20;
--
-- http_post 응답:
-- SELECT id, status_code, content, created
--   FROM net._http_response
--  ORDER BY id DESC
--  LIMIT 20;
--
-- 예약 대기 중인 캠페인 확인:
-- SELECT id, name, status, scheduled_at, user_id
--   FROM mailcaster.campaigns
--  WHERE status = 'scheduled'
--  ORDER BY scheduled_at ASC;
