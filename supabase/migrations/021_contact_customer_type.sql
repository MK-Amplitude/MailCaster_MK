-- =============================================
-- Phase 9 — 연락처 customer_type 필드
-- ---------------------------------------------
-- 목적: 연락처를 "Amplitude 기존 고객 / 영업 대상 / 일반" 3분류로 라벨링.
--   - 연락처 폼에서 직접 편집 가능
--   - 일괄 변경 (벌크 액션) 가능
--   - 그룹 멤버 시트의 검색/필터에서 활용
--
-- 컬럼: customer_type TEXT, default 'general'
-- CHECK 로 enum 흉내 (확장성을 위해 ENUM 타입 대신 TEXT+CHECK 채택)
-- =============================================

ALTER TABLE mailcaster.contacts
  ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'general'
    CHECK (customer_type IN ('amplitude_customer', 'prospect', 'general'));

-- 조회 인덱스: org_id + customer_type 조합 쿼리 가속.
-- 필터링은 항상 org_id 와 함께 일어나기 때문에 partial 보다 합성 인덱스가 유리.
CREATE INDEX IF NOT EXISTS idx_contacts_customer_type
  ON mailcaster.contacts (org_id, customer_type);

-- contact_with_groups 뷰는 c.* 로 자동 노출되지만, PostgreSQL 의 일부 환경에서
-- 컬럼 메타가 stale 해질 수 있어 명시적으로 재생성한다.
DROP VIEW IF EXISTS mailcaster.contact_with_groups;

CREATE VIEW mailcaster.contact_with_groups
WITH (security_invoker = true) AS
SELECT
  c.*,
  p.email        AS owner_email,
  p.display_name AS owner_name,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'group_id', g.id,
        'group_name', g.name,
        'category_id', gc.id,
        'category_name', gc.name,
        'category_color', gc.color
      )
    ) FILTER (WHERE g.id IS NOT NULL),
    '[]'::jsonb
  ) AS groups
FROM mailcaster.contacts c
LEFT JOIN mailcaster.profiles p          ON p.id = c.user_id
LEFT JOIN mailcaster.contact_groups cg   ON cg.contact_id = c.id
LEFT JOIN mailcaster.groups g            ON g.id = cg.group_id
LEFT JOIN mailcaster.group_categories gc ON gc.id = g.category_id
GROUP BY c.id, p.email, p.display_name;

GRANT SELECT ON mailcaster.contact_with_groups TO anon, authenticated, service_role;
