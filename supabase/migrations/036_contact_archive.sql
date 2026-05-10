-- =============================================
-- #15 비활성 연락처 archive
-- ---------------------------------------------
-- 목적: 1년 넘게 메일 발송도/응답도 없는 연락처를 기본 목록에서 숨겨 노이즈 감소.
--
-- 정책:
--   - archived_at IS NULL → 활성 (기본 목록)
--   - archived_at IS NOT NULL → 보관 (토글 켰을 때만 노출)
--   - 수동 archive/unarchive 가능
--   - mailcaster.archive_inactive_contacts() 함수 호출 시 1년+ inactive 자동 archive
--   - 사용자는 언제든 복원 가능 — 데이터 자체는 보존
-- =============================================

ALTER TABLE mailcaster.contacts
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- archived 가 아닌(=NULL) 행을 빠르게 필터하기 위한 partial index
CREATE INDEX IF NOT EXISTS contacts_active_idx
  ON mailcaster.contacts (org_id, created_at DESC)
  WHERE archived_at IS NULL;

-- contact_with_groups 뷰 재생성 — c.* 가 archived_at 노출하도록 컬럼 메타 캐시 갱신.
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

-- 비활성(1년+) 연락처를 자동 archive — 마지막 발송/응답 시각 기준.
-- 호출 예: SELECT mailcaster.archive_inactive_contacts(p_org_id => '...', p_threshold_days => 365);
-- p_org_id NULL 이면 모든 조직에 적용 (관리자/cron 용).
CREATE OR REPLACE FUNCTION mailcaster.archive_inactive_contacts(
  p_org_id UUID DEFAULT NULL,
  p_threshold_days INT DEFAULT 365
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_count INT;
  v_cutoff TIMESTAMPTZ := now() - (p_threshold_days || ' days')::INTERVAL;
BEGIN
  WITH activity AS (
    SELECT
      c.id,
      MAX(GREATEST(
        COALESCE(r.created_at, 'epoch'::timestamptz),
        COALESCE(r.replied_at, 'epoch'::timestamptz),
        COALESCE(r.first_opened_at, 'epoch'::timestamptz)
      )) AS last_touch
    FROM mailcaster.contacts c
    LEFT JOIN mailcaster.recipients r ON r.contact_id = c.id
    WHERE c.archived_at IS NULL
      AND (p_org_id IS NULL OR c.org_id = p_org_id)
    GROUP BY c.id
  ),
  -- 노트도 활동으로 간주 — 영업 메모를 남긴 연락처는 살아있는 관계.
  with_notes AS (
    SELECT
      a.id,
      GREATEST(a.last_touch, COALESCE(MAX(n.created_at), 'epoch'::timestamptz)) AS last_touch
    FROM activity a
    LEFT JOIN mailcaster.contact_notes n ON n.contact_id = a.id
    GROUP BY a.id, a.last_touch
  )
  UPDATE mailcaster.contacts c
  SET archived_at = now()
  FROM with_notes wn
  WHERE c.id = wn.id
    AND wn.last_touch < v_cutoff
    AND c.archived_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.archive_inactive_contacts(UUID, INT)
  TO authenticated, service_role;

COMMENT ON COLUMN mailcaster.contacts.archived_at IS
  '비활성 보관 시각. NULL = 활성. 수동 또는 archive_inactive_contacts() 자동 적용.';
