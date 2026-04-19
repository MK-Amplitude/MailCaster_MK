-- =============================================
-- Phase 6 hardening — 검증에서 발견된 이슈 수정
-- =============================================
--
-- 수정 항목:
--   C1) track_email_open race — campaigns.open_count 집계가
--       동시 요청 시 non-repeatable read 로 부정확할 수 있는 문제 수정.
--       recipients UPDATE 의 RETURNING 절에서 "이번 호출이 첫 오픈인지"
--       원자적으로 판정한 뒤, true 일 때만 campaigns.open_count 증가.
-- =============================================

-- ------------------------------------------------------------
-- C1. track_email_open 재작성 — RETURNING (open_count = 1) 패턴
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.track_email_open(
  p_recipient_id UUID,
  p_campaign_id  UUID,
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
  -- 1) recipient × campaign 유효성
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.recipients
     WHERE id = p_recipient_id
       AND campaign_id = p_campaign_id
  ) THEN
    RETURN; -- 픽셀은 항상 200 을 돌려줘야 하므로 에러 X
  END IF;

  -- 2) 감사 로그
  INSERT INTO mailcaster.open_events (recipient_id, campaign_id, ip, user_agent)
    VALUES (p_recipient_id, p_campaign_id, p_ip, p_user_agent);

  -- 3) 수신자 카운터 — 첫 오픈이면 opened/first_opened_at 세팅
  --    RETURNING (open_count = 1) 으로 "이번 호출 이후 값이 1인가" 를
  --    같은 statement 에서 원자적으로 판정.
  --    이렇게 하면 동시 오픈 2건이 들어와도 정확히 1건만 was_first = TRUE.
  UPDATE mailcaster.recipients
     SET opened          = TRUE,
         first_opened_at = COALESCE(first_opened_at, NOW()),
         opened_at       = NOW(),
         open_count      = COALESCE(open_count, 0) + 1
   WHERE id = p_recipient_id
  RETURNING (open_count = 1), campaign_id
    INTO v_was_first, v_campaign;

  -- 4) 캠페인 집계 — 첫 오픈일 때만 원자적으로 +1
  IF v_was_first THEN
    UPDATE mailcaster.campaigns
       SET open_count = COALESCE(open_count, 0) + 1
     WHERE id = v_campaign;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.track_email_open(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.track_email_open(UUID, UUID, TEXT, TEXT) TO service_role;
