-- =============================================
-- Phase 14.1 — 기존 회사명에서 부서 분리 백필
-- ---------------------------------------------
-- 새 LLM 프롬프트가 회사명에 섞인 부서를 분리하도록 업데이트됨.
-- 이미 'resolved' 상태인 연락처는 cron 이 재처리하지 않으므로, 부서 키워드를
-- 포함할 가능성이 있는 행만 골라 다시 'pending' 으로 돌려놓는다.
-- 동시에 해당 캐시 entry 도 삭제 (캐시 hit 시 옛 결과가 나오지 않도록).
--
-- 안전:
--   - department 가 이미 있는 행은 건드리지 않음 (사용자 입력 보존)
--   - 회사명에 부서 키워드가 없으면 건드리지 않음
--   - resolved → pending 전환만, 데이터 삭제 없음
--
-- 호출:
--   SELECT mailcaster.backfill_dept_extraction(p_org_id => '...');
-- =============================================

CREATE OR REPLACE FUNCTION mailcaster.backfill_dept_extraction(
  p_org_id UUID DEFAULT NULL
)
RETURNS TABLE(affected_contacts INT, deleted_cache INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_affected INT;
  v_cache INT;
  -- 부서임을 시사하는 키워드 — 회사명에 이 단어들이 끝부분에 붙어있으면 분리 후보.
  -- LIKE 패턴 — case-sensitive 이지만 한글이라 무관.
  v_pattern TEXT := '%(팀|실|본부|국|센터|사업부|연구소|연구원|Lab|Office|Division|Group|Department|HQ|Team)%';
BEGIN
  -- 1) 영향받을 raw_name 목록 — 캐시 비우기
  WITH targets AS (
    SELECT DISTINCT LOWER(company_raw) AS query_key
    FROM mailcaster.contacts
    WHERE (p_org_id IS NULL OR org_id = p_org_id)
      AND company_raw IS NOT NULL
      AND company_raw ~ '(팀|실|본부|국|센터|사업부|연구소|연구원|Lab|Office|Division|Group|Department|HQ|Team)'
      AND (department IS NULL OR TRIM(department) = '')
  )
  DELETE FROM mailcaster.company_cache
  WHERE query_key IN (SELECT query_key FROM targets);
  GET DIAGNOSTICS v_cache = ROW_COUNT;

  -- 2) 연락처 status 를 pending 으로 — 다음 cron tick 에서 새 LLM 호출
  UPDATE mailcaster.contacts
  SET company_lookup_status = 'pending',
      company_lookup_at = NULL
  WHERE (p_org_id IS NULL OR org_id = p_org_id)
    AND company_raw IS NOT NULL
    AND company_raw ~ '(팀|실|본부|국|센터|사업부|연구소|연구원|Lab|Office|Division|Group|Department|HQ|Team)'
    AND (department IS NULL OR TRIM(department) = '');
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RETURN QUERY SELECT v_affected, v_cache;
END;
$$;

GRANT EXECUTE ON FUNCTION mailcaster.backfill_dept_extraction(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION mailcaster.backfill_dept_extraction(UUID) IS
  '회사명에 부서가 섞여 있는 연락처를 다시 pending 으로 돌려 cron 이 재처리하게 한다. department 가 비어있는 경우만.';
