-- =============================================
-- Phase 7 — 신규 유저 자동화
-- ---------------------------------------------
-- 1) profiles INSERT 시 개인 워크스페이스 자동 생성
--    + owner 로 org_members 삽입
--    + 4 기본 카테고리 자동 생성 (기존 프론트엔드 seedDefaultCategories 이관)
-- 2) profiles INSERT 시 pending 초대(org_invitations) 자동 수락
-- =============================================

-- =============================================
-- 1. 개인 조직 자동 생성 트리거
-- ---------------------------------------------
-- profiles 에 새 행이 INSERT 되는 순간 (auth.users 에 의해 또는 수동 INSERT)
-- 해당 유저의 소유 조직을 하나 만들어 준다.
-- 이미 org_members 에 속한 레코드가 있으면 skip (재가입/테스트 시 안전).
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.create_personal_org_for_new_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  new_org_id UUID;
  org_name TEXT;
BEGIN
  -- 이미 어떤 조직이든 멤버이면 skip
  IF EXISTS (SELECT 1 FROM mailcaster.org_members WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  org_name := COALESCE(
    NULLIF(TRIM(NEW.display_name), ''),
    split_part(NEW.email, '@', 1)
  ) || '의 워크스페이스';

  INSERT INTO mailcaster.organizations (name, created_by)
  VALUES (org_name, NEW.id)
  RETURNING id INTO new_org_id;

  INSERT INTO mailcaster.org_members (org_id, user_id, role, invited_by)
  VALUES (new_org_id, NEW.id, 'owner', NEW.id);

  -- 기본 4개 카테고리 자동 생성 (기존 프론트엔드 seedDefaultCategories 이관)
  -- ON CONFLICT 로 재실행 안전
  INSERT INTO mailcaster.group_categories (user_id, org_id, name, color, icon, sort_order)
  VALUES
    (NEW.id, new_org_id, '고객사별', '#3b82f6', 'building-2', 0),
    (NEW.id, new_org_id, '업무별',   '#22c55e', 'briefcase',  1),
    (NEW.id, new_org_id, '직급별',   '#a855f7', 'user',       2),
    (NEW.id, new_org_id, '기타',     '#6b7280', 'bookmark',   3)
  ON CONFLICT (user_id, name) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_personal_org ON mailcaster.profiles;
CREATE TRIGGER trg_create_personal_org
  AFTER INSERT ON mailcaster.profiles
  FOR EACH ROW EXECUTE FUNCTION mailcaster.create_personal_org_for_new_profile();

-- =============================================
-- 2. Pending 초대 자동 수락 RPC
-- ---------------------------------------------
-- 로그인한 유저 본인의 이메일에 대한 미수락 초대를 조회/수락한다.
-- 프런트엔드에서 로그인 직후 호출.
--
-- 트리거가 아니라 RPC 로 만든 이유:
--   - handle_new_user (auth.users) 트리거에서 auth.users.email 접근은 가능하나
--     SECURITY DEFINER 라 별도 함수 호출이 더 안정적
--   - 기존 유저가 새로 초대받았을 때는 트리거가 안 뛰므로 로그인 때마다 실행해야 함
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.accept_pending_invitations()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  my_email TEXT;
  inv RECORD;
  accepted_count INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN 0;
  END IF;

  SELECT email INTO my_email FROM auth.users WHERE id = auth.uid();
  IF my_email IS NULL THEN
    RETURN 0;
  END IF;

  FOR inv IN
    SELECT id, org_id, role
    FROM mailcaster.org_invitations
    WHERE LOWER(email) = LOWER(my_email)
      AND accepted_at IS NULL
  LOOP
    -- 이미 멤버면 초대만 accepted 처리
    INSERT INTO mailcaster.org_members (org_id, user_id, role, invited_by)
    VALUES (inv.org_id, auth.uid(), inv.role, NULL)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    UPDATE mailcaster.org_invitations
    SET accepted_at = now()
    WHERE id = inv.id;

    accepted_count := accepted_count + 1;
  END LOOP;

  RETURN accepted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.accept_pending_invitations() TO authenticated, service_role;
