-- ============================================================
-- 012_campaign_cc_bcc_pickers.sql
-- ------------------------------------------------------------
-- CC / BCC 에도 수신자(To) 와 동일하게 "그룹 선택" / "개별 연락처 선택"
-- 패턴을 사용할 수 있도록 관계 테이블 4 개를 추가한다.
--
-- 설계 요점:
--   - campaigns.cc / campaigns.bcc (TEXT[]) 는 "발송 시점에 사용할 최종 이메일
--     리스트" 로 계속 기능한다. useSendCampaign 이 그대로 이 배열을 읽어 Gmail
--     헤더에 붙이므로 발송 경로는 전혀 바뀌지 않는다.
--   - 새 테이블은 "편집 모드에서 원래 선택을 복원" 하기 위한 메타데이터다.
--     저장 시: wizard 가 직접 입력 이메일 + 그룹 멤버 이메일 + 개별 연락처
--                   이메일을 union + dedupe 해 TEXT[] 에 밀어넣는다.
--              동시에 아래 4 개 테이블에 "어느 그룹/연락처를 골랐는지" 를 기록.
--     로드 시: wizard 가 이 4 개 테이블을 읽어 UI state 를 복원.
--
-- 트레이드오프:
--   - 그룹 멤버십이 나중에 바뀌면 campaigns.cc / bcc 는 그대로(스냅샷) 남음.
--     "편집"으로 재저장하면 그 시점 멤버십으로 다시 펼쳐진다. 이 동작은
--     To 측의 campaign_groups / campaign_contacts 과 동일하게 맞춘다.
--   - 같은 contact 가 그룹과 개별 양쪽에 들어 있어도, 저장할 때 이메일 기준
--     dedupe 이후 campaigns.cc 에는 1 번만 들어간다.
--
-- 변경 이력:
--   v1 (2026-04) — 최초 도입. CC/BCC 바구니 UI.
-- ============================================================


-- ------------------------------------------------------------
-- CC 측 — 그룹 / 연락처 선택
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.campaign_cc_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  group_id    UUID REFERENCES mailcaster.groups(id)    ON DELETE CASCADE NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_cc_groups_campaign
  ON mailcaster.campaign_cc_groups (campaign_id);

CREATE TABLE IF NOT EXISTS mailcaster.campaign_cc_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id  UUID REFERENCES mailcaster.contacts(id)  ON DELETE CASCADE NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_cc_contacts_campaign
  ON mailcaster.campaign_cc_contacts (campaign_id);


-- ------------------------------------------------------------
-- BCC 측 — 그룹 / 연락처 선택
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.campaign_bcc_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  group_id    UUID REFERENCES mailcaster.groups(id)    ON DELETE CASCADE NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_bcc_groups_campaign
  ON mailcaster.campaign_bcc_groups (campaign_id);

CREATE TABLE IF NOT EXISTS mailcaster.campaign_bcc_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES mailcaster.campaigns(id) ON DELETE CASCADE NOT NULL,
  contact_id  UUID REFERENCES mailcaster.contacts(id)  ON DELETE CASCADE NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_bcc_contacts_campaign
  ON mailcaster.campaign_bcc_contacts (campaign_id);


-- ------------------------------------------------------------
-- RLS — 캠페인 소유자만 읽기/쓰기
-- ------------------------------------------------------------
ALTER TABLE mailcaster.campaign_cc_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaign_cc_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaign_bcc_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.campaign_bcc_contacts ENABLE ROW LEVEL SECURITY;

-- USING : SELECT / UPDATE / DELETE 시 row 가시성 제어
-- WITH CHECK: INSERT / UPDATE 시 새로 쓰는 row 의 소유권 강제
-- (Postgres 는 WITH CHECK 생략 시 USING 과 동일하게 간주하지만, 의도를 명확히
--  하기 위해 양쪽을 모두 적는다. 기존 migration 009 는 USING 만 있지만 동작했음.)
CREATE POLICY "campaign_cc_groups: own" ON mailcaster.campaign_cc_groups
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  )
  WITH CHECK (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "campaign_cc_contacts: own" ON mailcaster.campaign_cc_contacts
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  )
  WITH CHECK (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "campaign_bcc_groups: own" ON mailcaster.campaign_bcc_groups
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  )
  WITH CHECK (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );

CREATE POLICY "campaign_bcc_contacts: own" ON mailcaster.campaign_bcc_contacts
  USING (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  )
  WITH CHECK (
    campaign_id IN (SELECT id FROM mailcaster.campaigns WHERE user_id = auth.uid())
  );


COMMENT ON TABLE mailcaster.campaign_cc_groups IS
  'CC 에 추가된 그룹 — 저장 시 campaigns.cc TEXT[] 에 이메일이 merge 됨. 편집 시 UI 복원용.';
COMMENT ON TABLE mailcaster.campaign_cc_contacts IS
  'CC 에 추가된 개별 연락처 — 저장 시 campaigns.cc TEXT[] 에 이메일이 merge 됨. 편집 시 UI 복원용.';
COMMENT ON TABLE mailcaster.campaign_bcc_groups IS
  'BCC 에 추가된 그룹 — 저장 시 campaigns.bcc TEXT[] 에 이메일이 merge 됨. 편집 시 UI 복원용.';
COMMENT ON TABLE mailcaster.campaign_bcc_contacts IS
  'BCC 에 추가된 개별 연락처 — 저장 시 campaigns.bcc TEXT[] 에 이메일이 merge 됨. 편집 시 UI 복원용.';
