-- ============================================================
-- 006_company_verification_cron.sql
-- ------------------------------------------------------------
-- 하루에 한 번 'pending' 또는 'failed' 상태의 회사명을 자동 재조회한다.
-- 'not_found' 는 자동 대상이 아니며 사용자가 수동으로 "다시 조회" 버튼을 눌러야 한다.
--
-- 사전 요구 사항 (Supabase Dashboard 에서 한 번만):
--   1) Database → Extensions 에서 pg_cron, pg_net 토글 ON
--   2) Edge Functions → Secrets 에 CRON_SECRET=<32+ 글자 랜덤 문자열> 저장
--   3) SQL Editor 에서 아래 두 줄 실행 (값은 실제 값으로):
--        SELECT vault.create_secret('https://<project-ref>.supabase.co', 'mailcaster_project_url');
--        SELECT vault.create_secret('<CRON_SECRET 과 동일한 값>',          'mailcaster_cron_secret');
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ------------------------------------------------------------
-- 기존 job 이 있으면 제거 (re-run 안전)
-- ------------------------------------------------------------
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-resolve-pending-companies') THEN
    PERFORM cron.unschedule('mailcaster-resolve-pending-companies');
  END IF;
END
$unsched$;

-- ------------------------------------------------------------
-- cron job 등록 — 매일 KST 03:00 (= UTC 18:00) 실행
-- vault 에서 URL/secret 을 인라인으로 꺼내어 edge function POST 호출
-- ------------------------------------------------------------
SELECT cron.schedule(
  'mailcaster-resolve-pending-companies',
  '0 18 * * *',
  $cronbody$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'mailcaster_project_url'
      ) || '/functions/v1/resolve-pending-companies',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
            FROM vault.decrypted_secrets
           WHERE name = 'mailcaster_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cronbody$
);

-- ------------------------------------------------------------
-- 참고: 수동 실행 / 로그 확인
-- ------------------------------------------------------------
-- 수동으로 한 번 호출 (cron 의 job body 와 동일):
-- SELECT net.http_post(
--   url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mailcaster_project_url')
--          || '/functions/v1/resolve-pending-companies',
--   headers := jsonb_build_object(
--     'Content-Type', 'application/json',
--     'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'mailcaster_cron_secret')
--   ),
--   body := '{}'::jsonb,
--   timeout_milliseconds := 60000
-- );
--
-- cron 최근 실행 기록:
-- SELECT jobname, status, return_message, start_time, end_time
--   FROM cron.job_run_details
--  WHERE jobname = 'mailcaster-resolve-pending-companies'
--  ORDER BY start_time DESC
--  LIMIT 10;
--
-- http_post 응답:
-- SELECT id, status_code, content, created
--   FROM net._http_response
--  ORDER BY id DESC
--  LIMIT 10;
