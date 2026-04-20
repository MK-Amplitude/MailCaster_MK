-- =============================================
-- Phase 7 — 리소스 테이블에 org_id 추가 + 기존 데이터 마이그레이션
-- ---------------------------------------------
-- 대상: contacts, groups, group_categories, templates, signatures, campaigns
-- 전략:
--   1. ADD COLUMN org_id (nullable)
--   2. DO 블록: 각 profile 마다 "개인 워크스페이스" 조직 자동 생성 + owner 로 삽입
--      + 해당 유저의 모든 리소스 org_id 를 그 조직으로 백필
--   3. ALTER COLUMN SET NOT NULL + FK 추가
--   4. org_id 인덱스 생성 (RLS 쿼리 성능)
--   5. contact_with_groups 뷰 재생성 (org_id 노출 확인)
--
-- 유저 정책:
--   - 오너(user_id) 는 리소스 생성자로 유지 (기존 동작과 동일)
--   - 다른 유저가 같은 email 의 contact 을 가지고 있어도 둘 다 살려둠 (UNIQUE(user_id, email) 유지)
--   - "공통" 뷰는 017 에서 제공
--
-- 주의: 기존 RLS 정책은 015 에서 DROP 후 재생성. 이 파일 실행 중에는
--       postgres 권한으로 DO 블록이 바이패스하므로 RLS 영향 없음.
-- =============================================

-- =============================================
-- 1. org_id 컬럼 추가 (nullable 상태로)
-- =============================================
ALTER TABLE mailcaster.contacts          ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.groups            ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.group_categories  ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.templates         ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.signatures        ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE mailcaster.campaigns         ADD COLUMN IF NOT EXISTS org_id UUID;

-- =============================================
-- 2. 기존 유저별 "개인 워크스페이스" 생성 + 리소스 백필
-- =============================================
DO $$
DECLARE
  prof RECORD;
  new_org_id UUID;
  org_name TEXT;
BEGIN
  FOR prof IN
    SELECT p.id, p.email, p.display_name
    FROM mailcaster.profiles p
    -- 이미 org_members 에 속해있는 유저는 skip (재실행 안전)
    WHERE NOT EXISTS (
      SELECT 1 FROM mailcaster.org_members om WHERE om.user_id = p.id
    )
  LOOP
    -- 조직명: "{display_name or email local part}의 워크스페이스"
    org_name := COALESCE(
      NULLIF(TRIM(prof.display_name), ''),
      split_part(prof.email, '@', 1)
    ) || '의 워크스페이스';

    INSERT INTO mailcaster.organizations (name, created_by)
    VALUES (org_name, prof.id)
    RETURNING id INTO new_org_id;

    INSERT INTO mailcaster.org_members (org_id, user_id, role, invited_by)
    VALUES (new_org_id, prof.id, 'owner', prof.id);

    -- 해당 유저의 리소스 백필
    UPDATE mailcaster.contacts         SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
    UPDATE mailcaster.groups           SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
    UPDATE mailcaster.group_categories SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
    UPDATE mailcaster.templates        SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
    UPDATE mailcaster.signatures       SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
    UPDATE mailcaster.campaigns        SET org_id = new_org_id WHERE user_id = prof.id AND org_id IS NULL;
  END LOOP;
END $$;

-- =============================================
-- 3. NOT NULL + FK 제약
-- ---------------------------------------------
-- ON DELETE CASCADE: 조직 삭제 시 리소스 전체 삭제 (일반 운영에선 rare)
-- =============================================
ALTER TABLE mailcaster.contacts
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT contacts_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

ALTER TABLE mailcaster.groups
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT groups_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

ALTER TABLE mailcaster.group_categories
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT group_categories_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

ALTER TABLE mailcaster.templates
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT templates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

ALTER TABLE mailcaster.signatures
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT signatures_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

ALTER TABLE mailcaster.campaigns
  ALTER COLUMN org_id SET NOT NULL,
  ADD CONSTRAINT campaigns_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES mailcaster.organizations(id) ON DELETE CASCADE;

-- =============================================
-- 4. 인덱스 (RLS 서브쿼리 `org_id IN (...)` 성능)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_contacts_org_id          ON mailcaster.contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_groups_org_id            ON mailcaster.groups(org_id);
CREATE INDEX IF NOT EXISTS idx_group_categories_org_id  ON mailcaster.group_categories(org_id);
CREATE INDEX IF NOT EXISTS idx_templates_org_id         ON mailcaster.templates(org_id);
CREATE INDEX IF NOT EXISTS idx_signatures_org_id        ON mailcaster.signatures(org_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_org_id         ON mailcaster.campaigns(org_id);

-- =============================================
-- 5. contact_with_groups 뷰 재생성
-- ---------------------------------------------
-- c.* 가 org_id 까지 자동 포함. owner_email/owner_name 유지.
-- security_invoker = true 로 호출자 RLS 적용.
-- =============================================
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
