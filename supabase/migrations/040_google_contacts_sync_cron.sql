-- =============================================
-- Phase 14 — Google Contacts 자동 동기화 cron
-- ---------------------------------------------
-- profiles.google_contacts_auto_sync=true 인 사용자들에 대해 매 시간 동기화 트리거.
-- 각 사용자마다 sync-google-contacts 함수를 fire-and-forget 호출.
--
-- 실행 주기: 매 정시 (0분에 1회)
-- 동시성: 사용자 N명이면 N번 호출. 각 호출은 비동기 (net.http_post).
-- =============================================

CREATE OR REPLACE FUNCTION mailcaster.dispatch_google_contacts_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_url TEXT;
  v_secret TEXT;
  r RECORD;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'mailcaster_project_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'mailcaster_cron_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE '[google-contacts-sync] vault secrets missing — skip';
    RETURN;
  END IF;

  FOR r IN
    SELECT id
    FROM mailcaster.profiles
    WHERE google_contacts_auto_sync = true
      AND google_refresh_token IS NOT NULL
  LOOP
    PERFORM net.http_post(
      url := v_url || '/functions/v1/sync-google-contacts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object('target_user_id', r.id),
      timeout_milliseconds := 55000
    );
  END LOOP;
END;
$$;

-- 매 시간 정시에 실행
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mailcaster-google-contacts-sync') THEN
    PERFORM cron.unschedule('mailcaster-google-contacts-sync');
  END IF;
  PERFORM cron.schedule(
    'mailcaster-google-contacts-sync',
    '0 * * * *',
    $cron$SELECT mailcaster.dispatch_google_contacts_sync();$cron$
  );
END;
$$;
