-- =============================================
-- Phase 14.5 — bulk contact 작업 권한 모델 일치
-- ---------------------------------------------
-- archive_inactive_contacts (036) / bulk_set_archived (042) 처럼, 조직 내 다른
-- owner 가 만든 연락처도 같은 조직 멤버라면 일괄 작업 가능하도록 RPC 통일.
-- 사용자 보고: "비활성 자동 보관"으로 archive 됐는데 다른 owner 행이 복원 안 되던
-- 문제와 같은 패턴이 bounce 해제 / customer_type 변경 / 수신거부 일괄 작업에도
-- 잠재. 미리 RPC 화.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) bulk_clear_bounce — 일괄 반송 해제
--    is_bounced=false 만 토글. bounce_count / last_bounced_at 이력은 보존.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.bulk_clear_bounce(
  p_org_id UUID,
  p_contact_ids UUID[]
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
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members
    WHERE org_id = p_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  UPDATE mailcaster.contacts
  SET is_bounced = false
  WHERE org_id = p_org_id
    AND id = ANY(p_contact_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.bulk_clear_bounce(UUID, UUID[])
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) bulk_set_unsubscribed — 일괄 수신거부 / 해제
--    is_unsubscribed + unsubscribed_at 토글. unsubscribes 테이블의 trigger (019)
--    가 우리 update 를 다시 따라잡지 않도록 직접 UPDATE 만 (org 멤버 검증으로 안전).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.bulk_set_unsubscribed(
  p_org_id UUID,
  p_contact_ids UUID[],
  p_unsubscribe BOOLEAN
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
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members
    WHERE org_id = p_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  UPDATE mailcaster.contacts
  SET is_unsubscribed = p_unsubscribe,
      unsubscribed_at = CASE WHEN p_unsubscribe THEN now() ELSE NULL END
  WHERE org_id = p_org_id
    AND id = ANY(p_contact_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.bulk_set_unsubscribed(UUID, UUID[], BOOLEAN)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) bulk_update_customer_type — 일괄 고객 분류 변경
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.bulk_update_customer_type(
  p_org_id UUID,
  p_contact_ids UUID[],
  p_customer_type TEXT
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
  IF p_customer_type NOT IN
    ('amplitude_customer', 'prospect', 'partner', 'vendor', 'relationship', 'general')
  THEN
    RAISE EXCEPTION '지원하지 않는 고객 분류: %', p_customer_type
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members
    WHERE org_id = p_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  UPDATE mailcaster.contacts
  SET customer_type = p_customer_type
  WHERE org_id = p_org_id
    AND id = ANY(p_contact_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.bulk_update_customer_type(UUID, UUID[], TEXT)
  TO authenticated, service_role;
