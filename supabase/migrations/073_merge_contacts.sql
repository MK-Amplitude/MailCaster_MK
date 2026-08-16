-- 073_merge_contacts.sql
-- =====================================================================
-- 중복 연락처 병합 RPC
--
-- 같은 사람이 동기화/CSV/수동 입력 등 여러 경로로 중복 생성됐을 때
-- 대표(primary) 1명으로 합치는 도구.
--
-- 동작:
--   1) 대표의 빈 필드를 병합 대상들의 값으로 보완 (COALESCE — 대표 값 우선)
--   2) 안전 플래그는 OR 병합 — 사본 중 하나라도 수신거부/반송이면 대표에 반영
--   3) 참조 이전: contact_groups / recipients / thread_messages / inbound_messages /
--      contact_notes / sequence_enrollments → 대표로 재지정
--      (UNIQUE 충돌 나는 행은 중복이므로 삭제)
--   4) 병합 대상 행 삭제
--
-- 보안: SECURITY DEFINER — 호출자의 org 멤버십을 user_org_ids() 로 직접 검증.
--       모든 대상이 같은 org 여야 하며, 호출자가 그 org 멤버여야 함.
-- =====================================================================

CREATE OR REPLACE FUNCTION mailcaster.merge_contacts(
  p_primary_id UUID,
  p_merge_ids  UUID[]
)
RETURNS TABLE (merged_count INT, moved_recipients INT, moved_threads INT, moved_inbound INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_org UUID;
  v_merge_ids UUID[];
  v_moved_recipients INT := 0;
  v_moved_threads INT := 0;
  v_moved_inbound INT := 0;
  v_row RECORD;
BEGIN
  -- 대표에서 자기 자신 제외
  v_merge_ids := ARRAY(SELECT DISTINCT x FROM unnest(p_merge_ids) AS x WHERE x <> p_primary_id);
  IF v_merge_ids IS NULL OR array_length(v_merge_ids, 1) IS NULL THEN
    RAISE EXCEPTION '병합할 연락처가 없습니다.';
  END IF;

  -- 대표 org + 호출자 멤버십 검증
  SELECT org_id INTO v_org FROM mailcaster.contacts WHERE id = p_primary_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION '대표 연락처를 찾을 수 없습니다.';
  END IF;
  IF v_org NOT IN (SELECT mailcaster.user_org_ids()) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.';
  END IF;
  -- 병합 대상 전원이 같은 org 인지
  IF EXISTS (
    SELECT 1 FROM mailcaster.contacts
     WHERE id = ANY(v_merge_ids) AND org_id IS DISTINCT FROM v_org
  ) THEN
    RAISE EXCEPTION '다른 조직의 연락처는 병합할 수 없습니다.';
  END IF;
  -- 존재하지 않는 id 가 섞여 있으면 중단 (부분 병합 방지)
  IF (SELECT COUNT(*) FROM mailcaster.contacts WHERE id = ANY(v_merge_ids))
     <> array_length(v_merge_ids, 1) THEN
    RAISE EXCEPTION '병합 대상 중 존재하지 않는 연락처가 있습니다.';
  END IF;

  -- 1) 대표 빈 필드 보완 — 병합 대상들을 최신 생성순으로 훑으며 채움
  FOR v_row IN
    SELECT * FROM mailcaster.contacts
     WHERE id = ANY(v_merge_ids)
     ORDER BY created_at DESC
  LOOP
    UPDATE mailcaster.contacts p
       SET name           = COALESCE(NULLIF(TRIM(p.name), ''),           v_row.name),
           phone          = COALESCE(NULLIF(TRIM(p.phone), ''),          v_row.phone),
           company        = COALESCE(NULLIF(TRIM(p.company), ''),        v_row.company),
           company_raw    = COALESCE(NULLIF(TRIM(p.company_raw), ''),    v_row.company_raw),
           company_ko     = COALESCE(NULLIF(TRIM(p.company_ko), ''),     v_row.company_ko),
           company_en     = COALESCE(NULLIF(TRIM(p.company_en), ''),     v_row.company_en),
           parent_group   = COALESCE(NULLIF(TRIM(p.parent_group), ''),   v_row.parent_group),
           job_title      = COALESCE(NULLIF(TRIM(p.job_title), ''),      v_row.job_title),
           display_title  = COALESCE(NULLIF(TRIM(p.display_title), ''),  v_row.display_title),
           department     = COALESCE(NULLIF(TRIM(p.department), ''),     v_row.department),
           memo           = COALESCE(NULLIF(TRIM(p.memo), ''),           v_row.memo),
           -- 안전 플래그 OR — 사본 하나라도 거부/반송이면 대표도 발송 차단
           is_unsubscribed = p.is_unsubscribed OR COALESCE(v_row.is_unsubscribed, FALSE),
           is_bounced      = p.is_bounced      OR COALESCE(v_row.is_bounced, FALSE)
     WHERE p.id = p_primary_id;
  END LOOP;

  -- 2) 그룹 멤버십 이전 — UNIQUE(contact_id, group_id) 충돌 행은 중복이므로 skip.
  --    주의: 병합 대상 2명이 같은 그룹에 있으면 단순 UPDATE ... NOT EXISTS 는
  --    한 statement 안에서 둘 다 통과해 UNIQUE 위반으로 전체 롤백됨 →
  --    그룹당 1행만 DISTINCT ON 으로 골라 이전.
  UPDATE mailcaster.contact_groups cg
     SET contact_id = p_primary_id
   WHERE cg.id IN (
     SELECT DISTINCT ON (e.group_id) e.id
       FROM mailcaster.contact_groups e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.contact_groups x
           WHERE x.contact_id = p_primary_id AND x.group_id = e.group_id
        )
      ORDER BY e.group_id
   );
  DELETE FROM mailcaster.contact_groups WHERE contact_id = ANY(v_merge_ids);

  -- 3) 발송/수신 이력 이전 (히스토리 보존)
  UPDATE mailcaster.recipients SET contact_id = p_primary_id
   WHERE contact_id = ANY(v_merge_ids);
  GET DIAGNOSTICS v_moved_recipients = ROW_COUNT;

  UPDATE mailcaster.thread_messages SET contact_id = p_primary_id
   WHERE contact_id = ANY(v_merge_ids);
  GET DIAGNOSTICS v_moved_threads = ROW_COUNT;

  UPDATE mailcaster.inbound_messages SET contact_id = p_primary_id
   WHERE contact_id = ANY(v_merge_ids);
  GET DIAGNOSTICS v_moved_inbound = ROW_COUNT;

  UPDATE mailcaster.contact_notes SET contact_id = p_primary_id
   WHERE contact_id = ANY(v_merge_ids);

  -- 시퀀스 등록 — UNIQUE(sequence_id, contact_id) 충돌 처리.
  -- 정책: active 우선 — 병합 대상의 진행 중(cadence) enrollment 이 대표의 종료된
  -- enrollment 때문에 삭제되면 자동 후속 발송이 소리 없이 끊긴다.
  -- 대표에 같은 시퀀스의 "종료" 행이 있고 병합 대상이 "active" 면 대표의 종료 행을 지우고 이전.
  DELETE FROM mailcaster.sequence_enrollments p
   USING mailcaster.sequence_enrollments e
   WHERE p.contact_id = p_primary_id
     AND p.status <> 'active'
     AND e.contact_id = ANY(v_merge_ids)
     AND e.sequence_id = p.sequence_id
     AND e.status = 'active';
  UPDATE mailcaster.sequence_enrollments se
     SET contact_id = p_primary_id
   WHERE se.id IN (
     SELECT DISTINCT ON (e.sequence_id) e.id
       FROM mailcaster.sequence_enrollments e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.sequence_enrollments x
           WHERE x.sequence_id = e.sequence_id AND x.contact_id = p_primary_id
        )
      -- 같은 시퀀스에 병합 대상 2명 이상이면 active > 최신 등록 순으로 1명만 이전
      ORDER BY e.sequence_id, (e.status = 'active') DESC, e.enrolled_at DESC
   );
  DELETE FROM mailcaster.sequence_enrollments WHERE contact_id = ANY(v_merge_ids);

  -- 캠페인 바구니/제외/CC/BCC — UNIQUE(campaign_id, contact_id) 충돌 skip 후 잔여 삭제
  -- (그룹과 동일하게 캠페인당 1행만 DISTINCT ON 으로 이전)
  UPDATE mailcaster.campaign_contacts cc
     SET contact_id = p_primary_id
   WHERE cc.id IN (
     SELECT DISTINCT ON (e.campaign_id) e.id
       FROM mailcaster.campaign_contacts e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.campaign_contacts x
           WHERE x.campaign_id = e.campaign_id AND x.contact_id = p_primary_id
        )
      ORDER BY e.campaign_id
   );
  DELETE FROM mailcaster.campaign_contacts WHERE contact_id = ANY(v_merge_ids);

  UPDATE mailcaster.campaign_exclusions ce
     SET contact_id = p_primary_id
   WHERE ce.id IN (
     SELECT DISTINCT ON (e.campaign_id) e.id
       FROM mailcaster.campaign_exclusions e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.campaign_exclusions x
           WHERE x.campaign_id = e.campaign_id AND x.contact_id = p_primary_id
        )
      ORDER BY e.campaign_id
   );
  DELETE FROM mailcaster.campaign_exclusions WHERE contact_id = ANY(v_merge_ids);

  UPDATE mailcaster.campaign_cc_contacts cc2
     SET contact_id = p_primary_id
   WHERE cc2.id IN (
     SELECT DISTINCT ON (e.campaign_id) e.id
       FROM mailcaster.campaign_cc_contacts e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.campaign_cc_contacts x
           WHERE x.campaign_id = e.campaign_id AND x.contact_id = p_primary_id
        )
      ORDER BY e.campaign_id
   );
  DELETE FROM mailcaster.campaign_cc_contacts WHERE contact_id = ANY(v_merge_ids);

  UPDATE mailcaster.campaign_bcc_contacts bc
     SET contact_id = p_primary_id
   WHERE bc.id IN (
     SELECT DISTINCT ON (e.campaign_id) e.id
       FROM mailcaster.campaign_bcc_contacts e
      WHERE e.contact_id = ANY(v_merge_ids)
        AND NOT EXISTS (
          SELECT 1 FROM mailcaster.campaign_bcc_contacts x
           WHERE x.campaign_id = e.campaign_id AND x.contact_id = p_primary_id
        )
      ORDER BY e.campaign_id
   );
  DELETE FROM mailcaster.campaign_bcc_contacts WHERE contact_id = ANY(v_merge_ids);

  -- 4) 병합 대상 삭제 (남은 CASCADE 참조 — company_history 등 — 는 함께 정리됨)
  DELETE FROM mailcaster.contacts WHERE id = ANY(v_merge_ids);

  RETURN QUERY SELECT array_length(v_merge_ids, 1), v_moved_recipients, v_moved_threads, v_moved_inbound;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.merge_contacts(UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.merge_contacts(UUID, UUID[]) TO authenticated, service_role;
