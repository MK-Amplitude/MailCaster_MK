-- =============================================
-- 076 — 보안 잠금 (2026-09 전체 보안 감사 후속)
-- ---------------------------------------------
-- 감사에서 확인된 핵심 문제:
--   C1. 001 의 ALTER DEFAULT PRIVILEGES ... GRANT ALL TO anon, authenticated 때문에
--       이후 모든 마이그레이션의 "REVOKE FROM PUBLIC + GRANT service_role" 패턴이
--       무력화됨 — anon/authenticated 는 함수 생성 시점의 *직접* grant 를 그대로
--       보유 (REVOKE FROM PUBLIC 은 직접 grant 를 제거하지 않음). 그 결과
--       track_*/record_*/claim_* 등 service_role 전용 RPC 가 anon 키만으로
--       /rest/v1/rpc/... 에서 호출 가능했음 (크로스 테넌트 유출·DoS·위조 가능).
--   C2. enroll_campaign_recipients 가 auth.uid() IS NULL 을 service_role 로
--       간주 — anon 호출도 NULL 이므로 무인증 우회 (anon EXECUTE 회수로 차단).
--   C3. archive_inactive_contacts 인증 부재 — 조직 무관 전체 보관 처리 가능.
--   H4. org_members_insert 정책의 부트스트랩 분기가 임의 org 에 자기 자신을
--       owner 로 INSERT 허용.
--   H5. org_invitations_update 가 초대받은 본인에게 컬럼 제한 없는 UPDATE 허용 —
--       role/org_id 를 스스로 바꿔 수락(자기 승격) 가능.
--   H6. backfill_dept_extraction 인증 부재 (org 무관 캐시 삭제 + LLM 재과금 유발).
--   H7. recipients RLS 가 FOR ALL org-visible — 일반 멤버가 동료 캠페인의
--       수신자 주소/본문(override)을 조작 가능.
--   M9. company_cache 가 모든 authenticated 에게 노출 — 타 테넌트 영업 대상 유출.
--   L10. email-images 버킷이 SVG 허용 — 저장 원점 XSS/피싱.
--   L13. engagement 뷰들의 anon SELECT 잔존.
-- =============================================

-- ------------------------------------------------------------
-- 1) anon 전면 회수 — 이 앱에 anon 의 정당한 DB 접근 경로는 없다.
--    (트래킹 픽셀/클릭은 Edge Function 이 service_role 로 처리)
-- ------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA mailcaster FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mailcaster FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mailcaster FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA mailcaster REVOKE ALL ON FUNCTIONS FROM anon;

-- ------------------------------------------------------------
-- 2) service_role 전용 함수 — authenticated 의 잔존 EXECUTE 회수.
--    (트리거/내부 헬퍼 포함. 클라이언트가 호출하는 RPC 는 목록에 없음:
--     archive_inactive_contacts, bulk_*, enroll_*, inbox_stats, outbound_funnel,
--     reply_rate_by_segment, sequence_step_funnel, stop_enrollment, merge_contacts,
--     accept_pending_invitations, user_org_ids, user_is_org_admin 은 유지)
-- ------------------------------------------------------------
DO $lockdown$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'mailcaster'
       AND p.proname = ANY (ARRAY[
         -- 트래킹 기록 (Edge track-open/track-click 전용 — 직접 호출 시 오픈/클릭 위조)
         'track_email_open', 'track_email_click', 'track_thread_open', 'track_thread_click',
         -- 인바운드/회신 기록 (check-inbox / check-replies 전용)
         'record_inbound_message', 'record_reply_optout', 'record_thread_reply',
         -- 시퀀스 워커 (process-sequences 전용 — 직접 호출 시 타 테넌트 행 유출 + next_run_at 밀림 DoS)
         'claim_due_sequence_steps', 'advance_enrollment', 'fail_enrollment_step',
         'defer_enrollment', 'stop_active_enrollments_for_contact',
         -- 운영 헬퍼 (cron 전용)
         'reconcile_stale_thread_messages', 'dispatch_google_contacts_sync',
         'backfill_dept_extraction',
         -- 트리거 함수/내부 헬퍼 — RPC 로 호출될 이유 없음
         'apply_unsubscribe_to_new_contact', 'sync_contacts_on_unsubscribe_change',
         'enforce_single_default_signature', 'update_group_member_count',
         'log_contact_history', 'tg_audit_log', 'tg_contact_notes_updated_at',
         'set_updated_at', 'audit_diff', 'add_business_days',
         'create_personal_org_for_new_profile', 'handle_new_user'
       ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$lockdown$;

-- ------------------------------------------------------------
-- 3) archive_inactive_contacts — 인증 가드 추가 (C3)
--    비-service_role 호출: 로그인 + p_org_id 필수 + 해당 org 멤버 + 최소 30일.
-- ------------------------------------------------------------
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
  v_uid UUID := auth.uid();
  v_role TEXT := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  -- 076 보안 가드 — service_role(cron/Edge) 이 아니면:
  --   · 로그인 필수, p_org_id 필수(전체 org 일괄 금지), 해당 org 멤버여야 함
  --   · threshold 최소 30일 (0일 지정으로 전체 연락처 보관 처리되는 실수/악용 방지)
  IF v_role IS DISTINCT FROM 'service_role' THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION '로그인이 필요합니다.' USING ERRCODE = '42501';
    END IF;
    IF p_org_id IS NULL THEN
      RAISE EXCEPTION '조직을 지정해야 합니다.' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mailcaster.org_members WHERE org_id = p_org_id AND user_id = v_uid
    ) THEN
      RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
    END IF;
    IF p_threshold_days < 30 THEN
      RAISE EXCEPTION '보관 기준은 최소 30일입니다.';
    END IF;
  END IF;

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

-- ------------------------------------------------------------
-- 4) org_members_insert — 부트스트랩 분기를 "그 조직의 생성자" 로 한정 (H4)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "org_members_insert" ON mailcaster.org_members;
CREATE POLICY "org_members_insert" ON mailcaster.org_members
  FOR INSERT
  WITH CHECK (
    mailcaster.user_is_org_admin(org_id)
    OR (
      user_id = auth.uid()
      AND role = 'owner'
      -- 최초 owner 셀프 삽입은 조직을 직접 만든 사람에게만 허용
      AND EXISTS (
        SELECT 1 FROM mailcaster.organizations o
        WHERE o.id = org_id AND o.created_by = auth.uid()
      )
    )
  );

-- ------------------------------------------------------------
-- 5) org_invitations_update — admin 전용으로 축소 (H5)
--    초대 수락은 accept_pending_invitations (SECURITY DEFINER) 가 처리하므로
--    초대받은 본인이 행을 UPDATE 할 정당한 경로가 없음. (role/org_id 셀프 변조 차단)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "org_invitations_update" ON mailcaster.org_invitations;
CREATE POLICY "org_invitations_update" ON mailcaster.org_invitations
  FOR UPDATE
  USING (mailcaster.user_is_org_admin(org_id))
  WITH CHECK (mailcaster.user_is_org_admin(org_id));

-- ------------------------------------------------------------
-- 6) recipients — 읽기는 org 멤버 전체, 쓰기는 캠페인 소유자/관리자만 (H7)
--    (일반 멤버가 동료 캠페인의 수신자 주소·개인화 본문을 조작해
--     동료 Gmail 로 임의 메일을 보내게 하던 구멍. campaigns 정책과 일관화)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "recipients_all_visible" ON mailcaster.recipients;

CREATE POLICY "recipients_select_org" ON mailcaster.recipients
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM mailcaster.campaigns c WHERE c.id = campaign_id)
  );

CREATE POLICY "recipients_insert_own_or_admin" ON mailcaster.recipients
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_id
        AND (c.user_id = auth.uid() OR mailcaster.user_is_org_admin(c.org_id))
    )
  );

CREATE POLICY "recipients_update_own_or_admin" ON mailcaster.recipients
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_id
        AND (c.user_id = auth.uid() OR mailcaster.user_is_org_admin(c.org_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_id
        AND (c.user_id = auth.uid() OR mailcaster.user_is_org_admin(c.org_id))
    )
  );

CREATE POLICY "recipients_delete_own_or_admin" ON mailcaster.recipients
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM mailcaster.campaigns c
      WHERE c.id = campaign_id
        AND (c.user_id = auth.uid() OR mailcaster.user_is_org_admin(c.org_id))
    )
  );

-- ------------------------------------------------------------
-- 7) company_cache — 클라이언트 노출 제거 (M9)
--    읽기/쓰기는 Edge Function(resolve-company, service_role)만 수행.
--    타 테넌트의 영업 대상 회사명(query_text) 열람 차단.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "company_cache: read" ON mailcaster.company_cache;
REVOKE ALL ON mailcaster.company_cache FROM authenticated;

-- ------------------------------------------------------------
-- 8) email-images 버킷 — SVG 업로드 차단 (L10, 저장 원점 XSS)
--    서명 이미지 업로드 UI 는 png/jpg 등 래스터만 실사용.
-- ------------------------------------------------------------
UPDATE storage.buckets
SET allowed_mime_types = array_remove(allowed_mime_types, 'image/svg+xml')
WHERE id = 'email-images';
