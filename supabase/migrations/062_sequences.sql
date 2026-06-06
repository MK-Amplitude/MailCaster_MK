-- =============================================
-- 고도화 Tier 1-A — 시퀀스(자동 후속 cadence) 엔진 데이터 모델
-- ---------------------------------------------
-- 관계 기반 B2B 자동 터치: 정해진 스텝(영업일 대기 + 템플릿)을 순서대로 자동 발송.
-- 엔진 전역 하드 정지: 회신/수신거부/반송 시 즉시 중단 (1-C 가 회신 정지 연결).
-- 스텝1 = 새 메일(mode='new'), 스텝2+ = 같은 thread 후속(mode='followup').
--
-- 발송: process-sequences cron edge function 이 claim_due_sequence_steps 로
--       due enrollment 를 원자적으로 집어(FOR UPDATE SKIP LOCKED) 발송 후 advance.
-- =============================================

-- ---------------------------------------------------------------
-- 0) 영업일 가산 헬퍼 — 주말(토/일) 건너뛰고 n 영업일 후 시각.
--    (공휴일 미반영 — v1 근사. 발송시간 정밀화는 Tier 2 에서.)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.add_business_days(p_from TIMESTAMPTZ, p_days INT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result TIMESTAMPTZ := p_from;
  v_added  INT := 0;
BEGIN
  IF p_days IS NULL OR p_days <= 0 THEN
    RETURN p_from;
  END IF;
  WHILE v_added < p_days LOOP
    v_result := v_result + INTERVAL '1 day';
    -- ISODOW: 1=월 … 7=일. 1~5 만 영업일.
    IF EXTRACT(ISODOW FROM v_result) < 6 THEN
      v_added := v_added + 1;
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------
-- 1) sequences — 시퀀스 정의
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.sequences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES mailcaster.profiles(id) ON DELETE CASCADE,  -- 발송 주체(Gmail 계정)
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sequences_org ON mailcaster.sequences (org_id, status, created_at DESC);

-- ---------------------------------------------------------------
-- 2) sequence_steps — 시퀀스의 순서 있는 스텝
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.sequence_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES mailcaster.sequences(id) ON DELETE CASCADE,
  step_order  INT  NOT NULL CHECK (step_order >= 1),
  -- 이전 스텝 발송(스텝1은 enroll) 이후 대기할 영업일 수. 스텝1은 보통 0(즉시).
  wait_days   INT  NOT NULL DEFAULT 0 CHECK (wait_days >= 0),
  subject     TEXT NOT NULL,
  body_html   TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_seq ON mailcaster.sequence_steps (sequence_id, step_order);

-- ---------------------------------------------------------------
-- 3) sequence_enrollments — contact 의 시퀀스 진행 상태
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mailcaster.sequence_enrollments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  sequence_id         UUID NOT NULL REFERENCES mailcaster.sequences(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES mailcaster.contacts(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
  -- 마지막으로 발송 완료한 스텝(0 = 아직 없음) / 다음에 보낼 스텝
  current_step_order  INT NOT NULL DEFAULT 0,
  next_step_order     INT NOT NULL DEFAULT 1,
  next_run_at         TIMESTAMPTZ,                 -- 다음 스텝 due 시각 (active 일 때)
  stopped_reason      TEXT CHECK (stopped_reason IN ('replied','unsubscribed','bounced','manual','completed','failed')),
  -- thread 이어가기용 (스텝2+ 가 같은 thread 후속으로)
  last_thread_id      TEXT,
  last_rfc_message_id TEXT,
  last_error          TEXT,
  enrolled_by         UUID REFERENCES mailcaster.profiles(id) ON DELETE SET NULL,
  enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);

-- 스케줄러가 due 행을 빠르게 — active + next_run_at 부분 인덱스
CREATE INDEX IF NOT EXISTS idx_seq_enroll_due
  ON mailcaster.sequence_enrollments (next_run_at)
  WHERE status = 'active';
-- 회신→정지 lookup
CREATE INDEX IF NOT EXISTS idx_seq_enroll_contact
  ON mailcaster.sequence_enrollments (contact_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_seq_enroll_org
  ON mailcaster.sequence_enrollments (org_id, status, enrolled_at DESC);

-- updated_at 자동 갱신
DROP TRIGGER IF EXISTS trg_sequences_updated ON mailcaster.sequences;
CREATE TRIGGER trg_sequences_updated BEFORE UPDATE ON mailcaster.sequences
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();
DROP TRIGGER IF EXISTS trg_seq_enroll_updated ON mailcaster.sequence_enrollments;
CREATE TRIGGER trg_seq_enroll_updated BEFORE UPDATE ON mailcaster.sequence_enrollments
  FOR EACH ROW EXECUTE FUNCTION mailcaster.set_updated_at();

-- ---------------------------------------------------------------
-- 4) RLS — 조직 멤버 기반 (056 컨벤션)
-- ---------------------------------------------------------------
ALTER TABLE mailcaster.sequences            ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.sequence_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailcaster.sequence_enrollments ENABLE ROW LEVEL SECURITY;

-- sequences: 조직 멤버 전체 CRUD
DROP POLICY IF EXISTS "sequences_org_all" ON mailcaster.sequences;
CREATE POLICY "sequences_org_all" ON mailcaster.sequences
  FOR ALL TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()))
  WITH CHECK (org_id IN (SELECT mailcaster.user_org_ids()));

-- sequence_steps: 소속 시퀀스가 내 org 면 CRUD
DROP POLICY IF EXISTS "sequence_steps_org_all" ON mailcaster.sequence_steps;
CREATE POLICY "sequence_steps_org_all" ON mailcaster.sequence_steps
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM mailcaster.sequences s
     WHERE s.id = sequence_steps.sequence_id
       AND s.org_id IN (SELECT mailcaster.user_org_ids())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM mailcaster.sequences s
     WHERE s.id = sequence_steps.sequence_id
       AND s.org_id IN (SELECT mailcaster.user_org_ids())
  ));

-- enrollments: 조직 멤버 SELECT 만. 변경은 RPC(SECURITY DEFINER)/service_role.
DROP POLICY IF EXISTS "seq_enroll_select_org" ON mailcaster.sequence_enrollments;
CREATE POLICY "seq_enroll_select_org" ON mailcaster.sequence_enrollments
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT mailcaster.user_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.sequences      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.sequence_steps TO authenticated;
GRANT SELECT                          ON mailcaster.sequence_enrollments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.sequences            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.sequence_steps       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailcaster.sequence_enrollments TO service_role;

-- ---------------------------------------------------------------
-- 5) RPC — enroll (authenticated)
--    org 멤버 검증 후, 미수신거부·미반송 contact 만 active 등록. 이미 있으면 skip.
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
  v_uid     UUID := auth.uid();
  v_org_id  UUID;
  v_first   INT;
  v_count   INT;
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

  -- 첫 스텝의 wait 는 보통 0 → next_run_at = now() (다음 cron tick 에 발송).
  SELECT COALESCE(MIN(step_order), 1) INTO v_first
    FROM mailcaster.sequence_steps WHERE sequence_id = p_sequence_id;

  WITH ins AS (
    INSERT INTO mailcaster.sequence_enrollments
      (org_id, sequence_id, contact_id, status, next_step_order, next_run_at, enrolled_by)
    SELECT v_org_id, p_sequence_id, c.id, 'active', v_first, now(), v_uid
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

-- ---------------------------------------------------------------
-- 6) RPC — stop_enrollment (authenticated, org 검증)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.stop_enrollment(
  p_enrollment_id UUID,
  p_reason        TEXT DEFAULT 'manual'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '인증이 필요합니다.' USING ERRCODE = '42501';
  END IF;
  SELECT org_id INTO v_org_id FROM mailcaster.sequence_enrollments WHERE id = p_enrollment_id;
  IF v_org_id IS NULL THEN RETURN FALSE; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mailcaster.org_members WHERE org_id = v_org_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION '이 조직의 멤버가 아닙니다.' USING ERRCODE = '42501';
  END IF;

  UPDATE mailcaster.sequence_enrollments
     SET status = 'stopped',
         stopped_reason = COALESCE(p_reason, 'manual'),
         next_run_at = NULL
   WHERE id = p_enrollment_id
     AND status = 'active';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.stop_enrollment(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.stop_enrollment(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------
-- 7) RPC — stop_active_enrollments_for_contact (service_role; 1-C 회신/반송/수신거부 정지)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.stop_active_enrollments_for_contact(
  p_org_id     UUID,
  p_contact_id UUID,
  p_reason     TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_count INT;
BEGIN
  IF p_org_id IS NULL OR p_contact_id IS NULL THEN RETURN 0; END IF;
  UPDATE mailcaster.sequence_enrollments
     SET status = 'stopped',
         stopped_reason = COALESCE(p_reason, 'replied'),
         next_run_at = NULL
   WHERE org_id = p_org_id
     AND contact_id = p_contact_id
     AND status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.stop_active_enrollments_for_contact(UUID, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.stop_active_enrollments_for_contact(UUID, UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------
-- 8) RPC — claim_due_sequence_steps (service_role; 스케줄러 원자적 클레임)
--    due active 행을 limit 만큼 잠그고(FOR UPDATE SKIP LOCKED), next_run_at 를
--    임시로 미뤄(15분) 동시 cron 중복 클레임 방지. 발송 후 advance 가 실제 시각 확정.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.claim_due_sequence_steps(p_limit INT DEFAULT 50)
RETURNS TABLE (
  enrollment_id   UUID,
  org_id          UUID,
  sequence_id     UUID,
  contact_id      UUID,
  step_order      INT,
  last_thread_id  TEXT,
  last_rfc_message_id TEXT,
  sender_user_id  UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id
      FROM mailcaster.sequence_enrollments e
      JOIN mailcaster.sequences s ON s.id = e.sequence_id AND s.status = 'active'
     WHERE e.status = 'active'
       AND e.next_run_at IS NOT NULL
       AND e.next_run_at <= now()
     ORDER BY e.next_run_at ASC
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE OF e SKIP LOCKED
  ),
  held AS (
    UPDATE mailcaster.sequence_enrollments e
       SET next_run_at = now() + INTERVAL '15 minutes'
      FROM due
     WHERE e.id = due.id
     RETURNING e.id, e.org_id, e.sequence_id, e.contact_id,
               e.next_step_order, e.last_thread_id, e.last_rfc_message_id
  )
  SELECT h.id, h.org_id, h.sequence_id, h.contact_id, h.next_step_order,
         h.last_thread_id, h.last_rfc_message_id, s.user_id
    FROM held h
    JOIN mailcaster.sequences s ON s.id = h.sequence_id;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.claim_due_sequence_steps(INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.claim_due_sequence_steps(INT) TO service_role;

-- ---------------------------------------------------------------
-- 9) RPC — advance_enrollment (service_role; 발송 성공 후 다음 스텝 예약/완료)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.advance_enrollment(
  p_enrollment_id     UUID,
  p_sent_step_order   INT,
  p_thread_id         TEXT,
  p_rfc_message_id    TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_seq_id     UUID;
  v_next_order INT;
  v_next_wait  INT;
BEGIN
  SELECT sequence_id INTO v_seq_id
    FROM mailcaster.sequence_enrollments WHERE id = p_enrollment_id;
  IF v_seq_id IS NULL THEN RETURN; END IF;

  -- 방금 보낸 스텝 다음의 최소 step_order
  SELECT step_order, wait_days INTO v_next_order, v_next_wait
    FROM mailcaster.sequence_steps
   WHERE sequence_id = v_seq_id
     AND step_order > p_sent_step_order
   ORDER BY step_order ASC
   LIMIT 1;

  IF v_next_order IS NULL THEN
    -- 더 보낼 스텝 없음 → 완료
    UPDATE mailcaster.sequence_enrollments
       SET status = 'completed',
           stopped_reason = 'completed',
           current_step_order = p_sent_step_order,
           next_step_order = p_sent_step_order,
           next_run_at = NULL,
           last_thread_id = COALESCE(p_thread_id, last_thread_id),
           last_rfc_message_id = COALESCE(p_rfc_message_id, last_rfc_message_id),
           last_error = NULL,
           completed_at = now()
     WHERE id = p_enrollment_id;
  ELSE
    UPDATE mailcaster.sequence_enrollments
       SET current_step_order = p_sent_step_order,
           next_step_order = v_next_order,
           next_run_at = mailcaster.add_business_days(now(), v_next_wait),
           last_thread_id = COALESCE(p_thread_id, last_thread_id),
           last_rfc_message_id = COALESCE(p_rfc_message_id, last_rfc_message_id),
           last_error = NULL
     WHERE id = p_enrollment_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.advance_enrollment(UUID, INT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.advance_enrollment(UUID, INT, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------
-- 10) RPC — fail_enrollment_step (service_role; 발송 실패 기록 + 재시도 예약)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION mailcaster.fail_enrollment_step(
  p_enrollment_id UUID,
  p_error         TEXT,
  p_retry_minutes INT DEFAULT 60
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
  UPDATE mailcaster.sequence_enrollments
     SET last_error = LEFT(COALESCE(p_error, 'send failed'), 500),
         next_run_at = now() + make_interval(mins => GREATEST(p_retry_minutes, 5))
   WHERE id = p_enrollment_id
     AND status = 'active';
$$;

REVOKE ALL ON FUNCTION mailcaster.fail_enrollment_step(UUID, TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.fail_enrollment_step(UUID, TEXT, INT) TO service_role;

COMMENT ON TABLE mailcaster.sequences IS '자동 후속 시퀀스 정의 (Tier 1 고도화).';
COMMENT ON TABLE mailcaster.sequence_steps IS '시퀀스의 순서 있는 스텝 (영업일 대기 + 템플릿).';
COMMENT ON TABLE mailcaster.sequence_enrollments IS 'contact 의 시퀀스 진행 상태 — process-sequences cron 이 발송/진행.';
