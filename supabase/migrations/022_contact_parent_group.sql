-- =============================================
-- Phase 9.1 — 연락처 parent_group 필드 (AI 자동 식별 그룹사)
-- ---------------------------------------------
-- 목적: 한국 대기업 그룹사(롯데/신세계/삼성/CJ/SK/GS/카카오/네이버/...)를
--   계열사 별로 자동 묶어서 보고, 필터링/그룹 발송에 활용한다.
--
--   - 기존 AI 회사명 정규화 파이프라인이 이미 company_ko/company_en 을 채우고 있으므로,
--     같은 호출에서 parent_group 만 추가로 받으면 됨 (cost 차이 거의 없음).
--   - 독립 기업(자회사 아님) 또는 식별 불가인 경우 NULL.
--
-- 컬럼 변경:
--   contacts.parent_group     TEXT  NULL  — 한국어 그룹명 (예: "롯데")
--   company_cache.parent_group TEXT NULL  — dedup cache 에도 동일
-- =============================================

ALTER TABLE mailcaster.contacts
  ADD COLUMN IF NOT EXISTS parent_group TEXT;

-- 그룹사 필터링용 인덱스. NULL 비율이 높을 가능성이 있어 partial 인덱스로.
CREATE INDEX IF NOT EXISTS idx_contacts_parent_group
  ON mailcaster.contacts (org_id, parent_group)
  WHERE parent_group IS NOT NULL;

ALTER TABLE mailcaster.company_cache
  ADD COLUMN IF NOT EXISTS parent_group TEXT;

-- contact_with_groups 뷰 재생성 — c.* 가 새 컬럼을 노출하도록.
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
