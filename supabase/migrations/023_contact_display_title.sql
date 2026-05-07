-- =============================================
-- Phase 9.2 — 연락처 사용 직책 (display_title)
-- ---------------------------------------------
-- 목적: job_title 이 "팀장/리드" 같이 복수 직책으로 적힌 경우, 메일 발송 시
--   대표 한 가지만 부르고 싶을 때를 위한 override 필드.
--
--   - 비어 있으면 (NULL) 기존 job_title 그대로 사용 (기존 발송 동작 보존).
--   - 값이 있으면 캠페인 recipients.variables 의 {{job_title}} 에 우선 사용됨.
--   - 원본 job_title 도 함께 보관해 {{job_title_raw}} 로 접근 가능.
-- =============================================

ALTER TABLE mailcaster.contacts
  ADD COLUMN IF NOT EXISTS display_title TEXT;

-- contact_with_groups 뷰는 c.* 로 자동 노출되지만 컬럼 메타 캐시 갱신을 위해 재생성.
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
