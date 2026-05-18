-- =============================================
-- Phase 13 — Outreach REST API 연동
-- ---------------------------------------------
-- 목적: MailCaster 에서 발송한 메일을 사용자의 Outreach 워크스페이스에
--   prospect activity 로 자동 기록. Outreach OAuth 2.0 으로 사용자별 토큰 발급.
--
-- 사용 흐름:
--   1) Settings → Outreach 연결 클릭 → OAuth flow → refresh_token 저장
--   2) 메일 발송 성공 시 outreach-sync-mailing 자동 호출:
--      a) prospect lookup (email) → 없으면 create
--      b) mailing record create (state='delivered', subject/body 첨부)
--      c) recipients.outreach_mailing_id 에 기록 (중복 방지)
--   3) 발송 후 N분 내 Outreach activity 에 노출
--
-- 컬럼:
--   profiles.outreach_access_token        — 자주 갱신, 보통 2시간 유효
--   profiles.outreach_refresh_token       — 영속, 사용자가 연결 해제 시 NULL
--   profiles.outreach_token_expires_at    — 만료 시각 (proactive refresh 용)
--   profiles.outreach_user_id             — Outreach 의 user id (API URL 빌드용)
--   recipients.outreach_mailing_id        — Outreach 의 mailing id (1번만 푸시)
-- =============================================

ALTER TABLE mailcaster.profiles
  ADD COLUMN IF NOT EXISTS outreach_access_token TEXT,
  ADD COLUMN IF NOT EXISTS outreach_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS outreach_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outreach_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS outreach_connected_at TIMESTAMPTZ;

ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS outreach_mailing_id BIGINT,
  ADD COLUMN IF NOT EXISTS outreach_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outreach_sync_error TEXT;

-- 중복 push 방지 + sync 상태 빠른 조회.
CREATE INDEX IF NOT EXISTS idx_recipients_outreach_sync
  ON mailcaster.recipients (campaign_id)
  WHERE outreach_mailing_id IS NOT NULL;

COMMENT ON COLUMN mailcaster.profiles.outreach_refresh_token IS
  'Outreach OAuth refresh_token. NULL = 연결 해제됨. service_role 만 접근.';
COMMENT ON COLUMN mailcaster.recipients.outreach_mailing_id IS
  'Outreach mailing id. NOT NULL = Outreach 에 동기화됨 — 중복 push 방지.';
COMMENT ON COLUMN mailcaster.recipients.outreach_sync_error IS
  '동기화 실패 사유. NULL 이면서 outreach_mailing_id 도 NULL = 아직 시도 안 함.';
