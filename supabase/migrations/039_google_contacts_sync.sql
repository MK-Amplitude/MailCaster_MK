-- =============================================
-- Phase 14 — Google Contacts 동기화 (리멤버 우회)
-- ---------------------------------------------
-- 리멤버 → 구글 주소록 자동 저장 (사용자가 리멤버 앱에서 설정) → MailCaster 가
-- People API 로 incremental sync. 기존 import 정책과 동일하게 email 기준 보존
-- (덮어쓰지 않음).
--
-- 컬럼:
--   profiles.google_contacts_sync_token  — People API 의 incremental syncToken.
--     NULL 이면 다음 호출 시 전체 sync (initial). 응답 syncToken 을 매번 저장.
--   profiles.google_contacts_last_sync_at — UI 표시용 마지막 sync 시각.
--   profiles.google_contacts_auto_sync   — 자동 sync 토글 (cron 이 참고).
-- =============================================

ALTER TABLE mailcaster.profiles
  ADD COLUMN IF NOT EXISTS google_contacts_sync_token TEXT,
  ADD COLUMN IF NOT EXISTS google_contacts_last_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS google_contacts_auto_sync BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN mailcaster.profiles.google_contacts_sync_token IS
  'Google People API incremental syncToken. NULL = 다음 호출 시 full sync.';
COMMENT ON COLUMN mailcaster.profiles.google_contacts_auto_sync IS
  '자동 동기화 토글 — true 면 매 시간 cron 이 sync-google-contacts 호출.';
