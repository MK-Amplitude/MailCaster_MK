-- =============================================
-- Phase 7 — Organizations (멀티 유저 공유 기반)
-- ---------------------------------------------
-- 목적: 같은 회사 직원끼리 연락처/템플릿/그룹/서명/캠페인 을 공유하되,
--        각 리소스의 오너(user_id)는 유지한다. 중복은 허용하고,
--        "공통" 뷰로 필요 시 병합해서 본다.
--
-- 공유 모델:
--   - organizations  : 조직 (N:1 profiles 를 N:N 으로 확장하는 매개체)
--   - org_members    : user ↔ org 매핑 + role (owner/admin/member)
--   - org_invitations: 로그인 전 사용자 대상 초대 (pending → accepted)
--
-- 기존 리소스 테이블 (contacts, groups, templates 등) 에는 014 에서 org_id 추가.
-- RLS 재작성은 015. 신규 유저 자동 조직 생성은 016.
-- =============================================

-- =============================================
-- 1. organizations
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON mailcaster.organizations;
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON mailcaster.organizations
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

-- =============================================
-- 2. org_members
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.org_members (
  org_id      UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON mailcaster.org_members(user_id);

-- =============================================
-- 3. org_invitations
-- ---------------------------------------------
-- 이메일로만 초대 (아직 로그인 안 한 사용자도 가능).
-- 해당 이메일의 사용자가 로그인하면 016 의 trigger/RPC 가 자동 수락.
-- =============================================
CREATE TABLE IF NOT EXISTS mailcaster.org_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  accepted_at  TIMESTAMPTZ,
  UNIQUE(org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON mailcaster.org_invitations(LOWER(email));

-- =============================================
-- 4. 헬퍼 함수: 현재 유저가 속한 조직 목록
-- ---------------------------------------------
-- STABLE + SECURITY DEFINER: RLS 정책 안에서 재귀/성능 이슈 없이 사용 가능.
-- 이 함수를 RLS 에서 쓰기 위해 search_path 고정.
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.user_org_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
  SELECT org_id FROM mailcaster.org_members WHERE user_id = auth.uid();
$$;

-- 관리자 여부 (owner/admin) — UPDATE/DELETE 다른 사람 리소스 권한 체크용
CREATE OR REPLACE FUNCTION mailcaster.user_is_org_admin(target_org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mailcaster.org_members
    WHERE org_id = target_org_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION mailcaster.user_org_ids()            TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION mailcaster.user_is_org_admin(UUID)   TO anon, authenticated, service_role;

-- =============================================
-- 5. RLS
-- =============================================
ALTER TABLE mailcaster.organizations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.org_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.org_invitations  ENABLE ROW LEVEL SECURITY;

-- organizations: 내가 속한 조직만 SELECT. UPDATE 는 owner/admin.
DROP POLICY IF EXISTS "organizations_select"  ON mailcaster.organizations;
DROP POLICY IF EXISTS "organizations_insert"  ON mailcaster.organizations;
DROP POLICY IF EXISTS "organizations_update"  ON mailcaster.organizations;
DROP POLICY IF EXISTS "organizations_delete"  ON mailcaster.organizations;

CREATE POLICY "organizations_select" ON mailcaster.organizations
  FOR SELECT
  USING (id IN (SELECT mailcaster.user_org_ids()));

-- 조직 생성은 로그인 사용자 아무나 가능 (created_by 자동 지정).
-- 이어서 org_members 에 owner 로 자기 자신 삽입해야 하므로 015 에 WITH CHECK 보강.
CREATE POLICY "organizations_insert" ON mailcaster.organizations
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND created_by = auth.uid());

CREATE POLICY "organizations_update" ON mailcaster.organizations
  FOR UPDATE
  USING (mailcaster.user_is_org_admin(id))
  WITH CHECK (mailcaster.user_is_org_admin(id));

CREATE POLICY "organizations_delete" ON mailcaster.organizations
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.org_members
      WHERE org_id = mailcaster.organizations.id
        AND user_id = auth.uid()
        AND role = 'owner'
    )
  );

-- org_members: 같은 조직의 멤버만 서로 볼 수 있음. admin+ 만 CUD.
DROP POLICY IF EXISTS "org_members_select"  ON mailcaster.org_members;
DROP POLICY IF EXISTS "org_members_insert"  ON mailcaster.org_members;
DROP POLICY IF EXISTS "org_members_update"  ON mailcaster.org_members;
DROP POLICY IF EXISTS "org_members_delete"  ON mailcaster.org_members;

CREATE POLICY "org_members_select" ON mailcaster.org_members
  FOR SELECT
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

-- INSERT: admin+ 이 멤버 추가 OR 자기 자신을 owner 로 삽입(조직 최초 생성 시점).
-- 두 번째 경로 없이 최초 조직 생성 불가능하므로 포함.
CREATE POLICY "org_members_insert" ON mailcaster.org_members
  FOR INSERT
  WITH CHECK (
    mailcaster.user_is_org_admin(org_id)
    OR (user_id = auth.uid() AND role = 'owner')
  );

CREATE POLICY "org_members_update" ON mailcaster.org_members
  FOR UPDATE
  USING (mailcaster.user_is_org_admin(org_id))
  WITH CHECK (mailcaster.user_is_org_admin(org_id));

-- DELETE: admin+ 이 내보내기 OR 본인이 탈퇴 (단, 마지막 owner 는 애플리케이션 레벨에서 막기)
CREATE POLICY "org_members_delete" ON mailcaster.org_members
  FOR DELETE
  USING (
    mailcaster.user_is_org_admin(org_id)
    OR user_id = auth.uid()
  );

-- org_invitations: admin+ 이 CRUD. 초대된 사람 본인도 조회 가능(수락 전이라 org 에 없음 → 이메일 매칭).
DROP POLICY IF EXISTS "org_invitations_select"  ON mailcaster.org_invitations;
DROP POLICY IF EXISTS "org_invitations_insert"  ON mailcaster.org_invitations;
DROP POLICY IF EXISTS "org_invitations_update"  ON mailcaster.org_invitations;
DROP POLICY IF EXISTS "org_invitations_delete"  ON mailcaster.org_invitations;

CREATE POLICY "org_invitations_select" ON mailcaster.org_invitations
  FOR SELECT
  USING (
    mailcaster.user_is_org_admin(org_id)
    OR LOWER(email) = LOWER((SELECT email FROM auth.users WHERE id = auth.uid()))
  );

CREATE POLICY "org_invitations_insert" ON mailcaster.org_invitations
  FOR INSERT
  WITH CHECK (mailcaster.user_is_org_admin(org_id));

CREATE POLICY "org_invitations_update" ON mailcaster.org_invitations
  FOR UPDATE
  USING (
    mailcaster.user_is_org_admin(org_id)
    OR LOWER(email) = LOWER((SELECT email FROM auth.users WHERE id = auth.uid()))
  )
  WITH CHECK (
    mailcaster.user_is_org_admin(org_id)
    OR LOWER(email) = LOWER((SELECT email FROM auth.users WHERE id = auth.uid()))
  );

CREATE POLICY "org_invitations_delete" ON mailcaster.org_invitations
  FOR DELETE
  USING (mailcaster.user_is_org_admin(org_id));

-- =============================================
-- 권한
-- =============================================
GRANT ALL ON mailcaster.organizations    TO anon, authenticated, service_role;
GRANT ALL ON mailcaster.org_members      TO anon, authenticated, service_role;
GRANT ALL ON mailcaster.org_invitations  TO anon, authenticated, service_role;
