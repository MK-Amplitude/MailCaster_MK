-- =============================================
-- Fix #035 — audit trigger row → jsonb 캐스트 오류
-- ---------------------------------------------
-- 035 의 tg_audit_log() 가 NEW::jsonb / OLD::jsonb 를 사용하는데,
-- PostgreSQL 은 row 타입 → jsonb 직접 캐스트를 허용하지 않음.
--   ERROR: 42846: cannot cast type contacts to jsonb
-- 결과: contacts/campaigns/groups/signatures/templates 의 모든 INSERT/UPDATE/DELETE 가 실패.
--
-- to_jsonb() 함수를 써야 함. audit_diff 의 시그니처는 그대로 유지 — 호출 측만 수정.
-- =============================================

CREATE OR REPLACE FUNCTION mailcaster.tg_audit_log()
RETURNS TRIGGER AS $$
DECLARE
  v_org_id UUID;
  v_target_id UUID;
  v_diff jsonb;
  v_uid UUID := auth.uid();
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_old := to_jsonb(OLD);
    v_org_id := (v_old->>'org_id')::UUID;
    v_target_id := (v_old->>'id')::UUID;
    v_diff := NULL;
  ELSE
    v_new := to_jsonb(NEW);
    v_org_id := (v_new->>'org_id')::UUID;
    v_target_id := (v_new->>'id')::UUID;
    IF (TG_OP = 'UPDATE') THEN
      v_old := to_jsonb(OLD);
      v_diff := mailcaster.audit_diff(v_old, v_new);
      -- 변경 사항 없으면 로그 X
      IF v_diff IS NULL THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  -- org_id 가 없는 row 는 audit X
  IF v_org_id IS NULL THEN
    IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO mailcaster.audit_log (
    org_id, user_id, action, target_type, target_id, diff
  ) VALUES (
    v_org_id,
    v_uid,
    LOWER(TG_OP),
    TG_TABLE_NAME,
    v_target_id,
    v_diff
  );

  IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = mailcaster, public;
