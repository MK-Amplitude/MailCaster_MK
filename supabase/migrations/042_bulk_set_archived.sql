-- =============================================
-- Fix #036 — bulk archive/restore 가 RLS 로 막히는 문제
-- ---------------------------------------------
-- 036 의 archive_inactive_contacts() 는 SECURITY DEFINER 라 조직 내 모든
-- 연락처를 archive 함 (owner 무관). 반면 frontend 의 bulk restore 는 직접
-- UPDATE 라 RLS 의 "contacts_update_own_or_admin" 정책에 막혀 다른 사용자
-- 소유 연락처는 silently skip 됨.
--
-- 일관성 회복: bulk archive/restore 도 같은 권한 모델 (조직 멤버 누구든)
-- 으로 동작하도록 RPC 함수 추가. SECURITY DEFINER + 호출자 멤버십 검증.
-- =============================================

CREATE OR REPLACE FUNCTION mailcaster.bulk_set_archived(
  p_org_id UUID,
  p_contact_ids UUID[],
  p_archive BOOLEAN
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_count INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '인증이 필요합니다.' USING ERRCODE = '42501';
  END IF;
  IF p_contact_ids IS NULL OR array_length(p_contact_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  -- 호출자가 해당 조직 멤버인지 확인
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members
    WHERE org_id = p_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  UPDATE mailcaster.contacts
  SET archived_at = CASE WHEN p_archive THEN now() ELSE NULL END
  WHERE org_id = p_org_id
    AND id = ANY(p_contact_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.bulk_set_archived(UUID, UUID[], BOOLEAN)
  TO authenticated, service_role;

COMMENT ON FUNCTION mailcaster.bulk_set_archived(UUID, UUID[], BOOLEAN) IS
  '조직 멤버라면 owner 와 무관하게 연락처 보관/복원 가능. archive_inactive_contacts() 와 권한 모델 일치.';
