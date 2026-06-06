-- =============================================
-- 고도화 Tier 4 — 캠페인 → 후속 시퀀스 연결
-- ---------------------------------------------
-- 캠페인(첫 터치) 발송 후, 수신자를 자동으로 후속 시퀀스에 등록한다.
-- 핵심: 캠페인이 보낸 메일의 gmail_thread_id / rfc_message_id 를 enrollment 에 넘겨,
--       시퀀스 첫 스텝이 같은 thread 의 followup 으로 나가게 한다(=중복 발송 없음).
--       (process-sequences 는 last_thread_id 가 있으면 mode='followup' 으로 발송)
--
-- 회신/수신거부/반송 자동 정지는 기존 엔진(check-inbox/process-sequences 가드 +
-- 본 마이그레이션이 추가하는 check-replies 정지)이 그대로 처리한다.
-- =============================================

-- ---------------------------------------------------------------
-- 1) recipients.rfc_message_id — 캠페인 발송 메일의 RFC Message-ID.
--    후속 시퀀스가 붙은 캠페인에서만 발송 경로가 best-effort 로 채운다.
--    시퀀스 followup 의 In-Reply-To/References 헤더로 사용 → 수신자 메일함에서도 스레드 연결.
--    NULL 이어도 gmail_thread_id(threadId 파라미터)로 Gmail 스레드는 묶인다.
-- ---------------------------------------------------------------
ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT;

-- ---------------------------------------------------------------
-- 2) campaigns.followup_sequence_id — 이 캠페인 발송 후 수신자를 등록할 후속 시퀀스.
--    NULL = 후속 없음(기존 동작). 시퀀스 삭제 시 NULL 로(캠페인은 유지).
-- ---------------------------------------------------------------
ALTER TABLE mailcaster.campaigns
  ADD COLUMN IF NOT EXISTS followup_sequence_id UUID
    REFERENCES mailcaster.sequences(id) ON DELETE SET NULL;

COMMENT ON COLUMN mailcaster.campaigns.followup_sequence_id IS
  '발송 완료 후 수신자를 등록할 후속 시퀀스. 캠페인=첫 터치, 시퀀스 스텝=후속.';

-- ---------------------------------------------------------------
-- 3) RPC — enroll_campaign_recipients (authenticated + service_role)
--    캠페인의 followup_sequence_id 가 가리키는 시퀀스에, 발송 완료된 수신자를 등록.
--    캠페인이 곧 "첫 터치" 이므로:
--      - last_thread_id / last_rfc_message_id 를 캠페인 발송 메일로 시드
--        → process-sequences 가 첫 스텝을 같은 thread 의 followup 으로 발송(중복 없음)
--      - next_run_at = 캠페인 발송 시각 + 첫 스텝 wait_days(영업일)
--    멱등: ON CONFLICT(sequence_id, contact_id) DO NOTHING. 여러 번 호출해도 안전.
--
--    호출 주체:
--      - authenticated: 즉시 발송(useSendCampaign) 직후 클라이언트가 호출 → org 멤버 검증.
--      - service_role : 예약 발송(send-scheduled-campaigns) 완료 시 호출 → 검증 skip.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.enroll_campaign_recipients(
  p_campaign_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_seq_id     UUID;
  v_org_id     UUID;
  v_camp_org   UUID;
  v_first      INT;
  v_first_wait INT;
  v_count      INT;
BEGIN
  -- 캠페인 → 후속 시퀀스 (+ 캠페인 org)
  SELECT followup_sequence_id, org_id INTO v_seq_id, v_camp_org
    FROM mailcaster.campaigns WHERE id = p_campaign_id;
  IF v_seq_id IS NULL THEN
    RETURN 0;  -- 후속 시퀀스 미지정 — 할 일 없음
  END IF;

  SELECT org_id INTO v_org_id FROM mailcaster.sequences WHERE id = v_seq_id;
  IF v_org_id IS NULL THEN
    RETURN 0;  -- 시퀀스가 사라짐(ON DELETE SET NULL 직전 race 등) — 조용히 종료
  END IF;

  -- 방어: 캠페인 org 과 시퀀스 org 가 다르면(잘못된 연결) 무음 0건 대신 명시적 종료.
  -- (FK 가 same-org 를 강제하지 않으므로 — UI 는 같은 org 만 노출하지만 방어적으로 확인)
  IF v_camp_org IS NULL OR v_camp_org <> v_org_id THEN
    RETURN 0;
  END IF;

  -- authenticated 호출이면 org 멤버 검증. service_role(auth.uid() IS NULL)은 통과.
  IF v_uid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM mailcaster.org_members WHERE org_id = v_org_id AND user_id = v_uid
    ) THEN
      RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 첫 스텝(최소 step_order)과 그 wait_days
  SELECT step_order, wait_days INTO v_first, v_first_wait
    FROM mailcaster.sequence_steps
   WHERE sequence_id = v_seq_id
   ORDER BY step_order ASC
   LIMIT 1;
  IF v_first IS NULL THEN
    RETURN 0;  -- 스텝 없는 시퀀스 — 등록 의미 없음
  END IF;

  -- 발송 완료(status='sent') + contact 연결 + 스레드 존재 + 미수신거부/미반송 수신자.
  -- 한 contact 가 여러 행이면 가장 먼저 발송된 행 1개만(DISTINCT ON) — 스레드 연속성 일관.
  WITH src AS (
    SELECT DISTINCT ON (r.contact_id)
           r.contact_id,
           r.gmail_thread_id,
           r.rfc_message_id,
           COALESCE(r.sent_at, now()) AS sent_at
      FROM mailcaster.recipients r
      JOIN mailcaster.contacts c ON c.id = r.contact_id
     WHERE r.campaign_id = p_campaign_id
       AND r.status = 'sent'
       AND r.contact_id IS NOT NULL
       AND r.gmail_thread_id IS NOT NULL
       AND c.org_id = v_org_id
       AND COALESCE(c.is_unsubscribed, FALSE) = FALSE
       AND COALESCE(c.is_bounced, FALSE) = FALSE
     ORDER BY r.contact_id, r.sent_at ASC NULLS LAST
  ),
  ins AS (
    INSERT INTO mailcaster.sequence_enrollments
      (org_id, sequence_id, contact_id, status,
       current_step_order, next_step_order, next_run_at,
       last_thread_id, last_rfc_message_id, enrolled_by)
    SELECT v_org_id, v_seq_id, s.contact_id, 'active',
           0, v_first,
           mailcaster.add_business_days(s.sent_at, v_first_wait),
           s.gmail_thread_id, s.rfc_message_id, v_uid
      FROM src s
    ON CONFLICT (sequence_id, contact_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.enroll_campaign_recipients(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.enroll_campaign_recipients(UUID) TO authenticated;
GRANT  EXECUTE ON FUNCTION mailcaster.enroll_campaign_recipients(UUID) TO service_role;

-- ---------------------------------------------------------------
-- 4) RPC — enroll_group_in_sequence (authenticated)
--    그룹의 모든 연락처를 시퀀스에 일괄 등록 (그룹 화면의 "시퀀스에 등록" 진입점).
--    enroll_contacts_in_sequence 와 동일 정책 — 미수신거부/미반송만, 첫 스텝 wait 영업일 뒤
--    (기본 0=즉시), 이미 등록된 contact 는 skip. 그룹/시퀀스가 같은 org 이고 호출자가 멤버여야 함.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.enroll_group_in_sequence(
  p_sequence_id UUID,
  p_group_id    UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_org_id     UUID;
  v_grp_org    UUID;
  v_first      INT;
  v_first_wait INT;
  v_count      INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '인증이 필요합니다.' USING ERRCODE = '42501';
  END IF;

  SELECT org_id INTO v_org_id FROM mailcaster.sequences WHERE id = p_sequence_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION '시퀀스를 찾을 수 없습니다.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members WHERE org_id = v_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  -- 그룹이 같은 org 인지 확인 (다른 org 그룹 등록 방지)
  SELECT org_id INTO v_grp_org FROM mailcaster.groups WHERE id = p_group_id;
  IF v_grp_org IS NULL OR v_grp_org <> v_org_id THEN
    RAISE EXCEPTION '그룹을 찾을 수 없거나 다른 조직입니다.';
  END IF;

  -- 첫 스텝의 순서/대기. 첫 스텝 wait>0 이면 그만큼 영업일 뒤 시작(기본 0=즉시).
  SELECT step_order, wait_days INTO v_first, v_first_wait
    FROM mailcaster.sequence_steps WHERE sequence_id = p_sequence_id
    ORDER BY step_order ASC LIMIT 1;
  IF v_first IS NULL THEN v_first := 1; v_first_wait := 0; END IF;

  WITH ins AS (
    INSERT INTO mailcaster.sequence_enrollments
      (org_id, sequence_id, contact_id, status, next_step_order, next_run_at, enrolled_by)
    SELECT v_org_id, p_sequence_id, c.id, 'active', v_first,
           mailcaster.add_business_days(now(), COALESCE(v_first_wait, 0)), v_uid
      FROM mailcaster.contact_groups cg
      JOIN mailcaster.contacts c ON c.id = cg.contact_id
     WHERE cg.group_id = p_group_id
       AND c.org_id = v_org_id
       AND COALESCE(c.is_unsubscribed, FALSE) = FALSE
       AND COALESCE(c.is_bounced, FALSE) = FALSE
    ON CONFLICT (sequence_id, contact_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.enroll_group_in_sequence(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.enroll_group_in_sequence(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------
-- 5) RPC — enroll_contacts_in_sequence 갱신 (062 함수 교체)
--    첫 스텝의 wait_days 를 존중하도록 next_run_at 을 add_business_days(now(), wait) 로.
--    (기존 062 는 항상 now() — 첫 스텝 wait 가 보통 0 이라 동작 동일. 빌더에서 첫 스텝 wait 를
--     편집 가능하게 하면서, 직접/그룹/캠페인 모든 등록 경로가 일관되게 첫 스텝 대기를 적용.)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.enroll_contacts_in_sequence(
  p_sequence_id UUID,
  p_contact_ids UUID[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_org_id     UUID;
  v_first      INT;
  v_first_wait INT;
  v_count      INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '인증이 필요합니다.' USING ERRCODE = '42501';
  END IF;
  IF p_contact_ids IS NULL OR array_length(p_contact_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  SELECT org_id INTO v_org_id FROM mailcaster.sequences WHERE id = p_sequence_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION '시퀀스를 찾을 수 없습니다.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members WHERE org_id = v_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  -- 첫 스텝의 순서/대기 (없으면 기본 1/0).
  SELECT step_order, wait_days INTO v_first, v_first_wait
    FROM mailcaster.sequence_steps WHERE sequence_id = p_sequence_id
    ORDER BY step_order ASC LIMIT 1;
  IF v_first IS NULL THEN v_first := 1; v_first_wait := 0; END IF;

  WITH ins AS (
    INSERT INTO mailcaster.sequence_enrollments
      (org_id, sequence_id, contact_id, status, next_step_order, next_run_at, enrolled_by)
    SELECT v_org_id, p_sequence_id, c.id, 'active', v_first,
           mailcaster.add_business_days(now(), COALESCE(v_first_wait, 0)), v_uid
      FROM mailcaster.contacts c
     WHERE c.id = ANY(p_contact_ids)
       AND c.org_id = v_org_id
       AND COALESCE(c.is_unsubscribed, FALSE) = FALSE
       AND COALESCE(c.is_bounced, FALSE) = FALSE
    ON CONFLICT (sequence_id, contact_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.enroll_contacts_in_sequence(UUID, UUID[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.enroll_contacts_in_sequence(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION mailcaster.enroll_campaign_recipients IS
  '캠페인 발송 완료 후 수신자를 후속 시퀀스에 등록 (캠페인 스레드에 이어지는 followup).';
COMMENT ON FUNCTION mailcaster.enroll_group_in_sequence IS
  '그룹의 모든 연락처를 시퀀스에 일괄 등록.';
