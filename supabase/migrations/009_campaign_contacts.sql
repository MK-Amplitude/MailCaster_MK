-- ============================================================
-- 009_campaign_contacts.sql
-- ------------------------------------------------------------
-- Phase 5 — 수신자 바구니 패턴
--   기존: 캠페인 수신자 = (campaign_groups 에서 풀어낸 연락처) 집합
--   변경: 캠페인 수신자 = (campaign_groups ∪ campaign_contacts) 집합 (이메일 중복 제거)
--
-- campaign_groups 와 병존하는 child 테이블. 바구니 UI 에서 "개별 연락처 추가" 로
-- 들어온 항목들만 여기에 저장된다. (그룹 전체 추가는 여전히 campaign_groups 에)
--
-- recipients 테이블에는 발송 직전(캠페인 저장 시점) 에 양쪽 소스를 union + dedup 해서
-- insert 한다. 편집 모드에서는 campaign_contacts 를 로드해 바구니 상태를 복원.
--
-- 변경 이력:
--   v1 (2026-04) — Phase 5 도입.
-- ============================================================

CREATE TABLE IF NOT EXISTS mailcaster.campaign_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id  UUID REFERENCES mailcaster.contacts(id)  ON DELETE CASCADE NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

-- 캠페인 단위 조회 — 편집 모드에서 "바구니 복원" 시 campaign_id 로 swipe
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign
  ON mailcaster.campaign_contacts (campaign_id);

-- RLS — 소유 캠페인의 것만
ALTER TABLE mailcaster.campaign_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaign_contacts: own" ON mailcaster.campaign_contacts
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );
