-- =============================================
-- 077 — 죽은 기능 잔재 컬럼 정리 (2026-09 전체 점검 후속)
-- ---------------------------------------------
-- 1) Slack 알림: 설정 UI 가 값을 저장만 하고, 이를 읽어 알림을 보내는 코드가
--    어디에도 없던 미완성 기능 — UI 는 프런트에서 제거됨. 컬럼도 정리.
-- 2) Outreach 연동(038): 설명된 outreach-sync-mailing Edge Function 이
--    구현된 적 없고, 프런트/함수 어디서도 컬럼을 읽고 쓰지 않음.
--    특히 profiles.outreach_access_token/refresh_token 은 평문 토큰 컬럼이라
--    빈 채로도 남겨둘 이유가 없음.
-- =============================================

ALTER TABLE mailcaster.profiles
  DROP COLUMN IF EXISTS slack_webhook_url,
  DROP COLUMN IF EXISTS slack_channel_name,
  DROP COLUMN IF EXISTS outreach_access_token,
  DROP COLUMN IF EXISTS outreach_refresh_token,
  DROP COLUMN IF EXISTS outreach_token_expires_at,
  DROP COLUMN IF EXISTS outreach_user_id,
  DROP COLUMN IF EXISTS outreach_connected_at;

ALTER TABLE mailcaster.recipients
  DROP COLUMN IF EXISTS outreach_mailing_id,
  DROP COLUMN IF EXISTS outreach_synced_at,
  DROP COLUMN IF EXISTS outreach_sync_error;
