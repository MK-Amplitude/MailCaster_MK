-- =============================================
-- Phase 2: 회사명 정규화 + 변경 이력
-- =============================================

-- 1) contacts 테이블 확장
-- ---------------------------------------------
ALTER TABLE mailcaster.contacts
  ADD COLUMN IF NOT EXISTS company_raw TEXT,
  ADD COLUMN IF NOT EXISTS company_ko TEXT,
  ADD COLUMN IF NOT EXISTS company_en TEXT,
  ADD COLUMN IF NOT EXISTS company_lookup_status TEXT DEFAULT 'pending'
    CHECK (company_lookup_status IN ('pending', 'resolved', 'not_found', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS company_lookup_at TIMESTAMPTZ;

-- 기존 company 값을 raw 로 백필
UPDATE mailcaster.contacts
SET company_raw = company
WHERE company_raw IS NULL AND company IS NOT NULL;

-- 2) 회사명 조회 캐시 (전역 공유, 호출 중복 제거)
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.company_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  query_key TEXT GENERATED ALWAYS AS (lower(trim(query_text))) STORED,
  name_ko TEXT,
  name_en TEXT,
  confidence NUMERIC(3, 2),
  source TEXT DEFAULT 'openai',
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (query_key)
);

ALTER TABLE mailcaster.company_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_cache: read" ON mailcaster.company_cache;
CREATE POLICY "company_cache: read" ON mailcaster.company_cache
  FOR SELECT USING (auth.role() = 'authenticated');

-- 3) 연락처 변경 이력
-- ---------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.contact_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES mailcaster.contacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  snapshot JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_history_contact
  ON mailcaster.contact_history (contact_id, changed_at DESC);

ALTER TABLE mailcaster.contact_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contact_history: own" ON mailcaster.contact_history;
CREATE POLICY "contact_history: own" ON mailcaster.contact_history
  USING (user_id = auth.uid());

-- 4) 변경 이력 자동 기록 트리거
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.log_contact_history()
RETURNS TRIGGER AS $$
DECLARE
  changed TEXT[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mailcaster.contact_history (contact_id, user_id, action, changed_fields, snapshot)
    VALUES (NEW.id, NEW.user_id, 'create', ARRAY[]::TEXT[], to_jsonb(NEW));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.email          IS DISTINCT FROM NEW.email          THEN changed := array_append(changed, 'email'); END IF;
    IF OLD.name           IS DISTINCT FROM NEW.name           THEN changed := array_append(changed, 'name'); END IF;
    IF OLD.company        IS DISTINCT FROM NEW.company        THEN changed := array_append(changed, 'company'); END IF;
    IF OLD.company_raw    IS DISTINCT FROM NEW.company_raw    THEN changed := array_append(changed, 'company_raw'); END IF;
    IF OLD.company_ko     IS DISTINCT FROM NEW.company_ko     THEN changed := array_append(changed, 'company_ko'); END IF;
    IF OLD.company_en     IS DISTINCT FROM NEW.company_en     THEN changed := array_append(changed, 'company_en'); END IF;
    IF OLD.department     IS DISTINCT FROM NEW.department     THEN changed := array_append(changed, 'department'); END IF;
    IF OLD.job_title      IS DISTINCT FROM NEW.job_title      THEN changed := array_append(changed, 'job_title'); END IF;
    IF OLD.phone          IS DISTINCT FROM NEW.phone          THEN changed := array_append(changed, 'phone'); END IF;
    IF OLD.memo           IS DISTINCT FROM NEW.memo           THEN changed := array_append(changed, 'memo'); END IF;

    -- 의미 있는 변경이 있을 때만 이력 기록 (OLD 스냅샷 = 변경 직전 상태)
    IF array_length(changed, 1) > 0 THEN
      INSERT INTO mailcaster.contact_history (contact_id, user_id, action, changed_fields, snapshot)
      VALUES (NEW.id, NEW.user_id, 'update', changed, to_jsonb(OLD));
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = mailcaster, pg_temp;

DROP TRIGGER IF EXISTS trg_log_contact_history ON mailcaster.contacts;
CREATE TRIGGER trg_log_contact_history
AFTER INSERT OR UPDATE ON mailcaster.contacts
FOR EACH ROW EXECUTE FUNCTION mailcaster.log_contact_history();

-- 5) contact_with_groups 뷰 재생성 (소유자 정보 포함)
-- ---------------------------------------------
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
LEFT JOIN mailcaster.profiles p         ON p.id = c.user_id
LEFT JOIN mailcaster.contact_groups cg  ON cg.contact_id = c.id
LEFT JOIN mailcaster.groups g           ON g.id = cg.group_id
LEFT JOIN mailcaster.group_categories gc ON gc.id = g.category_id
GROUP BY c.id, p.email, p.display_name;

-- 6) company_cache updated_at 자동 갱신
-- ---------------------------------------------
DROP TRIGGER IF EXISTS trg_company_cache_updated_at ON mailcaster.company_cache;
CREATE TRIGGER trg_company_cache_updated_at
BEFORE UPDATE ON mailcaster.company_cache
FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();
