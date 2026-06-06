-- =============================================
-- 고도화 Tier 2 — 발송 도달률 가드레일 (org 단위 설정)
-- ---------------------------------------------
-- 시퀀스 자동 발송(process-sequences)이 Gmail 계정 평판/한도를 해치지 않도록:
--   - 일일 발송 한도(rolling 24h) + 워밍업 램프
--   - 업무시간 발송창(시간대 기준) + 주말 제외 옵션
-- 한도/창 밖이면 process-sequences 가 enrollment 를 defer_enrollment 로 미룬다.
--
-- 적용 범위: 자동 발송원인 시퀀스 엔진. 캠페인(send-scheduled-campaigns)은
-- 사용자가 직접 일정/지연을 통제하므로 별도.
-- =============================================

CREATE TABLE IF NOT EXISTS mailcaster.org_send_settings (
  org_id            UUID PRIMARY KEY REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  -- rolling 24h 내 시퀀스 자동 발송 상한
  daily_send_limit  INT NOT NULL DEFAULT 100 CHECK (daily_send_limit >= 0),
  -- 업무시간 발송창 (org timezone 기준, [start, end) )
  window_start_hour INT NOT NULL DEFAULT 8  CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour   INT NOT NULL DEFAULT 18 CHECK (window_end_hour BETWEEN 1 AND 24),
  send_on_weekends  BOOLEAN NOT NULL DEFAULT FALSE,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Seoul',
  -- 워밍업: warmup_start>0 이고 warmup_started_at 설정 시,
  --   효과 한도 = min(daily_send_limit, warmup_start + warmup_per_day * (오늘-시작일))
  warmup_start      INT NOT NULL DEFAULT 0  CHECK (warmup_start >= 0),  -- 0 = 비활성
  warmup_per_day    INT NOT NULL DEFAULT 20 CHECK (warmup_per_day >= 0),
  warmup_started_at DATE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end_hour > window_start_hour)
);

ALTER TABLE mailcaster.org_send_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_send_settings_org_all" ON mailcaster.org_send_settings;
CREATE POLICY "org_send_settings_org_all" ON mailcaster.org_send_settings
  FOR ALL TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()))
  WITH CHECK (org_id IN (SELECT mailcaster.user_org_ids()));

GRANT SELECT, INSERT, UPDATE ON mailcaster.org_send_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON mailcaster.org_send_settings TO service_role;

DROP TRIGGER IF EXISTS trg_org_send_settings_updated ON mailcaster.org_send_settings;
CREATE TRIGGER trg_org_send_settings_updated BEFORE UPDATE ON mailcaster.org_send_settings
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

COMMENT ON TABLE mailcaster.org_send_settings IS
  '시퀀스 자동 발송 가드레일 — 일일 한도/워밍업/업무시간 발송창 (Tier 2 고도화). 없으면 기본값 사용.';

-- defer_enrollment — 한도/창 밖일 때 enrollment 를 미룸 (service_role; process-sequences).
CREATE OR REPLACE FUNCTION mailcaster.defer_enrollment(
  p_enrollment_id UUID,
  p_minutes       INT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  UPDATE mailcaster.sequence_enrollments
     SET next_run_at = now() + make_interval(mins => GREATEST(p_minutes, 5))
   WHERE id = p_enrollment_id
     AND status = 'active';
$$;

REVOKE ALL ON FUNCTION mailcaster.defer_enrollment(UUID, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.defer_enrollment(UUID, INT) TO service_role;

COMMENT ON FUNCTION mailcaster.defer_enrollment IS
  '발송 한도/업무시간 창 밖일 때 시퀀스 enrollment 의 next_run_at 을 미룸 (Tier 2).';
