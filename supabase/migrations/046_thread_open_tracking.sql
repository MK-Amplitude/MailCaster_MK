-- =============================================
-- Phase 17 — Thread Message Open Tracking
-- ---------------------------------------------
-- thread_messages (팔로업/회신/전달) 의 오픈 추적.
-- recipients 와 동일한 패턴 — opened/first_opened_at/last_opened_at/open_count.
--
-- 이벤트 단위 상세 로그 (open_events 같은 별도 테이블) 는 V1 에서 생략 —
-- thread_messages row 자체에 요약 컬럼만 두고, 필요해지면 후속 마이그레이션에서 추가.
--
-- 트래킹 픽셀 URL:
--   GET /functions/v1/track-open?tmid=<thread_message_id>
--
-- track-open 엣지 함수는 tmid 가 있으면 track_thread_open RPC 를, rid+cid 가 있으면
-- 기존 track_email_open RPC 를 호출한다.
-- =============================================

-- 1) thread_messages 에 트래킹 컬럼 추가
ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS opened          BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS first_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_opened_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS open_count      INTEGER     NOT NULL DEFAULT 0;

-- opened 인 thread_messages 만 인덱스 — "최근 오픈된 follow-up 모아보기" 용
CREATE INDEX IF NOT EXISTS idx_thread_messages_opened_recent
  ON mailcaster.thread_messages (org_id, last_opened_at DESC)
  WHERE opened = TRUE;

-- 2) RPC — service_role 만 호출 (엣지 함수 안에서)
-- recipients.track_email_open 과 동일한 패턴이지만 캠페인 집계는 없음
-- (thread_message 는 캠페인 발송 단위가 아니라 1:1 후속 메일이라 별도 카운터 불필요).
CREATE OR REPLACE FUNCTION mailcaster.track_thread_open(
  p_thread_message_id UUID,
  p_ip                TEXT DEFAULT NULL,
  p_user_agent        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
BEGIN
  -- 픽셀은 항상 200 을 돌려줘야 하므로 ID 가 없거나 잘못돼도 에러 X
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.thread_messages WHERE id = p_thread_message_id
  ) THEN
    RETURN;
  END IF;

  -- p_ip / p_user_agent 는 현재 시점엔 저장하지 않음 (요약 컬럼만 갱신).
  -- 향후 thread_open_events 테이블이 추가되면 거기 INSERT 하는 식으로 확장.
  UPDATE mailcaster.thread_messages
     SET opened          = TRUE,
         first_opened_at = COALESCE(first_opened_at, NOW()),
         last_opened_at  = NOW(),
         open_count      = COALESCE(open_count, 0) + 1
   WHERE id = p_thread_message_id;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.track_thread_open(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.track_thread_open(UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION mailcaster.track_thread_open(UUID, TEXT, TEXT) IS
  'thread_messages 오픈 픽셀 호출 시 카운터/타임스탬프 갱신. service_role 전용.';
