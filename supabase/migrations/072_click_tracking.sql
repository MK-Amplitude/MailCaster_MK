-- 072_click_tracking.sql
-- =====================================================================
-- 링크 클릭 트래킹 — 오픈 트래킹(011)과 동일한 구조로 클릭 이벤트 추가.
--
-- 배경: 오픈 픽셀은 Gmail 이미지 프록시·Apple MPP 로 갈수록 부정확.
-- 본문 링크를 track-click Edge Function 리다이렉트로 감싸 실제 클릭을 기록.
--   - 캠페인 개별 발송: rid+cid 로 수신자 단위 기록
--   - 시퀀스/스레드 발송: tmid 로 기록
-- URL 은 발송 시점에 HMAC 서명되어 open-redirect 악용 차단 (track-click 에서 검증).
-- =====================================================================

-- 1) 수신자/캠페인/스레드 클릭 카운터
ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS clicked          BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS click_count      INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at       TIMESTAMPTZ;

ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;

ALTER TABLE mailcaster.thread_messages
  ADD COLUMN IF NOT EXISTS clicked          BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS click_count      INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ;

-- 2) 클릭 이벤트 감사 로그
CREATE TABLE IF NOT EXISTS mailcaster.click_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id      UUID REFERENCES mailcaster.recipients(id)      ON DELETE CASCADE,
  campaign_id       UUID REFERENCES mailcaster.campaigns(id)       ON DELETE CASCADE,
  thread_message_id UUID REFERENCES mailcaster.thread_messages(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  ip                TEXT,
  user_agent        TEXT,
  clicked_at        TIMESTAMPTZ DEFAULT now(),
  -- 캠페인 경로(rid+cid) 또는 스레드 경로(tmid) 중 하나는 반드시 있어야 함
  CONSTRAINT click_events_target CHECK (
    (recipient_id IS NOT NULL AND campaign_id IS NOT NULL)
    OR thread_message_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_click_events_campaign
  ON mailcaster.click_events (campaign_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_click_events_recipient
  ON mailcaster.click_events (recipient_id);
CREATE INDEX IF NOT EXISTS idx_click_events_thread
  ON mailcaster.click_events (thread_message_id);

ALTER TABLE mailcaster.click_events ENABLE ROW LEVEL SECURITY;
-- open_events(015) 와 동일 정책 — 상위 테이블(campaigns/thread_messages) RLS 에 위임
DROP POLICY IF EXISTS "click_events_visible" ON mailcaster.click_events;
CREATE POLICY "click_events_visible" ON mailcaster.click_events
  FOR SELECT
  USING (
    (campaign_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id))
    OR (thread_message_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM mailcaster.thread_messages tm WHERE tm.id = thread_message_id))
  );

GRANT SELECT ON mailcaster.click_events TO authenticated, service_role;

-- 3) 캠페인 클릭 RPC — track_email_open(011) 의 RETURNING 원자 판정 패턴 그대로
CREATE OR REPLACE FUNCTION mailcaster.track_email_click(
  p_recipient_id UUID,
  p_campaign_id  UUID,
  p_url          TEXT,
  p_ip           TEXT DEFAULT NULL,
  p_user_agent   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_was_first BOOLEAN := FALSE;
  v_campaign  UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.recipients
     WHERE id = p_recipient_id AND campaign_id = p_campaign_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO mailcaster.click_events (recipient_id, campaign_id, url, ip, user_agent)
    VALUES (p_recipient_id, p_campaign_id, LEFT(p_url, 2000), p_ip, p_user_agent);

  UPDATE mailcaster.recipients
     SET clicked          = TRUE,
         first_clicked_at = COALESCE(first_clicked_at, NOW()),
         clicked_at       = NOW(),
         click_count      = COALESCE(click_count, 0) + 1
   WHERE id = p_recipient_id
  RETURNING (click_count = 1), campaign_id
    INTO v_was_first, v_campaign;

  IF v_was_first THEN
    UPDATE mailcaster.campaigns
       SET click_count = COALESCE(click_count, 0) + 1
     WHERE id = v_campaign;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.track_email_click(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.track_email_click(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- 4) 스레드/시퀀스 클릭 RPC
CREATE OR REPLACE FUNCTION mailcaster.track_thread_click(
  p_thread_message_id UUID,
  p_url               TEXT,
  p_ip                TEXT DEFAULT NULL,
  p_user_agent        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.thread_messages WHERE id = p_thread_message_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO mailcaster.click_events (thread_message_id, url, ip, user_agent)
    VALUES (p_thread_message_id, LEFT(p_url, 2000), p_ip, p_user_agent);

  UPDATE mailcaster.thread_messages
     SET clicked          = TRUE,
         first_clicked_at = COALESCE(first_clicked_at, NOW()),
         click_count      = COALESCE(click_count, 0) + 1
   WHERE id = p_thread_message_id;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.track_thread_click(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.track_thread_click(UUID, TEXT, TEXT, TEXT) TO service_role;
