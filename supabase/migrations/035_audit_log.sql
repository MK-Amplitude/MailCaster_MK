-- =============================================
-- Phase 12 — Audit log
-- ---------------------------------------------
-- 누가 언제 무엇을 변경했는지 기록. 영업팀 협업 환경에서 \"이 캠페인 누가
-- 수정했지?\" 같은 질문에 즉답.
--
-- 구조:
--   audit_log (
--     id UUID,
--     org_id UUID,
--     user_id UUID,
--     action: insert | update | delete,
--     target_type: campaigns | contacts | groups | signatures | templates | ...,
--     target_id UUID,
--     diff JSONB,  -- update 시 바뀐 컬럼만
--     created_at TIMESTAMPTZ
--   )
--
-- 트리거 대상:
--   - campaigns / contacts / groups / signatures / templates
--   (recipients/notes 처럼 자주 일어나는 작은 변경은 제외 — 노이즈 ↑)
--
-- 보안 (RLS):
--   - SELECT: 같은 org 멤버 (협업)
--   - INSERT: 시스템(트리거) 만 — RLS 우회는 SECURITY DEFINER 함수로 처리
--   - UPDATE/DELETE: 모두 차단 (immutable)
--
-- 보존: 90일 후 자동 purge — 별도 cron 으로 정기 정리 (TODO).
-- =============================================

CREATE TABLE IF NOT EXISTS mailcaster.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES mailcaster.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  diff JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 가장 자주 쓰는 쿼리 — org 별 최근 활동 timeline.
CREATE INDEX IF NOT EXISTS idx_audit_log_org_recent
  ON mailcaster.audit_log (org_id, created_at DESC);

-- target 별 활동 (특정 캠페인/연락처 변경 이력 조회).
CREATE INDEX IF NOT EXISTS idx_audit_log_target
  ON mailcaster.audit_log (target_type, target_id, created_at DESC);

-- ------------------------------------------------------------
-- 변경 차이 추출 — 업데이트 전후 jsonb 에서 다른 키만 골라 jsonb 반환.
-- 예: { "before": { col: oldVal }, "after": { col: newVal } } 형식.
-- 무거운 텍스트(body_html 등) 는 길이만 기록해 audit_log 폭증 방지.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.audit_diff(old_row jsonb, new_row jsonb)
RETURNS jsonb AS $$
DECLARE
  k TEXT;
  before_obj jsonb := '{}'::jsonb;
  after_obj jsonb := '{}'::jsonb;
  ov jsonb;
  nv jsonb;
  HEAVY_KEYS text[] := ARRAY['body_html', 'html', 'body_html_override'];
BEGIN
  FOR k IN SELECT jsonb_object_keys(new_row) LOOP
    ov := old_row -> k;
    nv := new_row -> k;
    IF ov IS DISTINCT FROM nv THEN
      -- 무거운 컬럼은 길이만 기록
      IF k = ANY(HEAVY_KEYS) THEN
        before_obj := before_obj || jsonb_build_object(k,
          jsonb_build_object('len', length(ov::text)));
        after_obj := after_obj || jsonb_build_object(k,
          jsonb_build_object('len', length(nv::text)));
      ELSE
        before_obj := before_obj || jsonb_build_object(k, ov);
        after_obj := after_obj || jsonb_build_object(k, nv);
      END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(after_obj) = 'object' AND after_obj <> '{}'::jsonb THEN
    RETURN jsonb_build_object('before', before_obj, 'after', after_obj);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- 공통 트리거 함수 — TG_TABLE_NAME 으로 target_type 자동 결정.
-- SECURITY DEFINER 로 정의해 RLS 우회 + auth.uid() 로 user 식별.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.tg_audit_log()
RETURNS TRIGGER AS $$
DECLARE
  v_org_id UUID;
  v_target_id UUID;
  v_diff jsonb;
  v_uid UUID := auth.uid();
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_org_id := (OLD::jsonb->>'org_id')::UUID;
    v_target_id := (OLD::jsonb->>'id')::UUID;
    v_diff := NULL;
  ELSE
    v_org_id := (NEW::jsonb->>'org_id')::UUID;
    v_target_id := (NEW::jsonb->>'id')::UUID;
    IF (TG_OP = 'UPDATE') THEN
      v_diff := mailcaster.audit_diff(OLD::jsonb, NEW::jsonb);
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

-- ------------------------------------------------------------
-- 트리거 장착 — 핵심 테이블 5개
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_campaigns ON mailcaster.campaigns;
CREATE TRIGGER audit_campaigns
  AFTER INSERT OR UPDATE OR DELETE ON mailcaster.campaigns
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

DROP TRIGGER IF EXISTS audit_contacts ON mailcaster.contacts;
CREATE TRIGGER audit_contacts
  AFTER INSERT OR UPDATE OR DELETE ON mailcaster.contacts
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

DROP TRIGGER IF EXISTS audit_groups ON mailcaster.groups;
CREATE TRIGGER audit_groups
  AFTER INSERT OR UPDATE OR DELETE ON mailcaster.groups
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

DROP TRIGGER IF EXISTS audit_signatures ON mailcaster.signatures;
CREATE TRIGGER audit_signatures
  AFTER INSERT OR UPDATE OR DELETE ON mailcaster.signatures
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

DROP TRIGGER IF EXISTS audit_templates ON mailcaster.templates;
CREATE TRIGGER audit_templates
  AFTER INSERT OR UPDATE OR DELETE ON mailcaster.templates
  FOR EACH ROW EXECUTE FUNCTION mailcaster.tg_audit_log();

-- ------------------------------------------------------------
-- RLS — 같은 org 멤버 SELECT 만, 변경/삭제는 차단 (immutable)
-- ------------------------------------------------------------
ALTER TABLE mailcaster.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log: org members read" ON mailcaster.audit_log;
CREATE POLICY "audit_log: org members read"
  ON mailcaster.audit_log FOR SELECT
  TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

GRANT SELECT ON mailcaster.audit_log TO authenticated;
-- service_role 만 INSERT (트리거가 SECURITY DEFINER 로 우회)
GRANT INSERT ON mailcaster.audit_log TO service_role;
