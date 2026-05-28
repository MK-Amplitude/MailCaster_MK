-- =============================================
-- Phase 20.1 — campaigns.kind enum (broadcast / one_to_one)
-- ---------------------------------------------
-- 사용자 관찰: "캠페인 매니지먼트보다 메일 발송 위주로 사용됨."
-- 데이터 모델 레벨에서 broadcast (다중) 와 one_to_one (1:1) 발송을 분리 →
-- UI 가 둘을 다르게 렌더할 수 있도록.
--
-- 정책:
--   - 기존 row: total_count > 1 이면 'broadcast', 그 외 'one_to_one' 으로 backfill
--   - 새 row: 기본 'broadcast' (wizard 발송) / mode='new' thread 는 별도 흐름 (campaigns 안 만듦)
-- =============================================

ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'broadcast'
    CHECK (kind IN ('broadcast', 'one_to_one'));

-- backfill — 기존 row 의 total_count 기준 분류
UPDATE mailcaster.campaigns
   SET kind = CASE WHEN total_count <= 1 THEN 'one_to_one' ELSE 'broadcast' END
 WHERE kind = 'broadcast'  -- DEFAULT 로 들어간 모든 row 대상
   AND total_count <= 1;

CREATE INDEX IF NOT EXISTS idx_campaigns_kind
  ON mailcaster.campaigns (org_id, kind, created_at DESC);

COMMENT ON COLUMN mailcaster.campaigns.kind IS
  'broadcast = 다중 수신자 캠페인 발송 (마케팅) / one_to_one = 1:1 또는 소수 발송 (Sales).';
