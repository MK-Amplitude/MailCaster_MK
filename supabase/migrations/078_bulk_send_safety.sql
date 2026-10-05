-- =============================================
-- 078 — 대량 발송 안전장치: 수신거부 목록의 조직 단위 일관성
-- ---------------------------------------------
-- 1) 사용자 삭제 시 수신거부/차단 기록 보존 (#51)
--    001 의 unsubscribes/blacklist.user_id 가 profiles ON DELETE CASCADE 라서,
--    퇴사자 계정 삭제 시 그 사람이 등록한(답장 자동 감지 포함) 수신거부가 통째로 삭제되고
--    019 트리거 DELETE 분기가 조직 전체 contacts.is_unsubscribed 를 FALSE 로 되돌렸다.
--    → user_id NULL 허용 + ON DELETE SET NULL. (UPDATE 이므로 019 DELETE 트리거 미발동)
--    수신거부는 조직 소유 — user_id 는 등록자 추적용일 뿐.
--
-- 1-b) unsubscribes.source — 등록 경로 표시. 수신자 본인이 한 수신거부(link / one_click / reply)는
--    발송자가 지울 수 없게 보호 (영업 담당자가 명시적으로 거부한 잠재고객을 재구독시키는 것 방지).
--      · NULL / 'manual' : 조직 멤버가 수동 등록 — 018 RLS 그대로 (본인 등록분 OR admin)
--      · 'link' / 'one_click' (079 unsubscribe_by_token), 'reply' (record_reply_optout /
--        record_thread_reply_optout) : 수신자 발신 — user_id NULL 로 저장, admin 만 수정/삭제.
--    기존 답장 자동 감지 행(061, user_id = 캠페인 소유자)은 reason 으로 'reply' 백필.
--
-- 2) bulk_set_unsubscribed (043) 이 unsubscribes 에도 기록 (#25)
--    기존엔 선택한 contacts 행 플래그만 바꿔서, 같은 조직 다른 멤버의 사본·재import·
--    Google 연락처 동기화로 생긴 새 contact 는 계속 발송 대상이었고 수신거부 관리 화면에도
--    남지 않았다. 단건 토글(useToggleUnsubscribe)과 같은 규칙으로 맞춤:
--      · 수신거부: unsubscribes INSERT (019 트리거가 조직 전체 사본 동기화)
--      · 해제   : 호출자 본인이 수동 등록한 행만 unsubscribes DELETE. 수신자 발신(link/one_click/
--                 reply) 행과 다른 사람이 등록한 행은 admin 이어도 일괄 해제로는 지우지 않음
--                 (admin 은 수신거부 관리 화면에서 건별 삭제). 기록이 남은 contact 는 플래그 유지.
--    시그니처(p_org_id, p_contact_ids, p_unsubscribe) / 반환(INT) 은 그대로 — 프런트 호환.
--
-- 3) record_thread_reply_optout — 1:1 스레드(thread_messages) 회신에서 수신거부 감지 시
--    check-replies pass3 가 호출 (service_role 전용). 캠페인이 없는 스레드도 org 로 등록.
--    record_reply_optout (061) 도 같은 규칙(source='reply', user_id NULL)으로 재정의 — 시그니처 동일.
--
-- 멱등: 몇 번 재실행해도 같은 결과.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) unsubscribes / blacklist .user_id FK → ON DELETE SET NULL
-- ─────────────────────────────────────────────────────────────────────────────
DO $fk$
DECLARE
  r RECORD;
BEGIN
  -- SET NULL('n') 이 아닌 user_id → profiles FK 만 제거 (이름 무관 — 001 은 이름 없이 생성)
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f'
       AND c.conrelid IN ('mailcaster.unsubscribes'::regclass, 'mailcaster.blacklist'::regclass)
       AND c.confrelid = 'mailcaster.profiles'::regclass
       AND a.attname = 'user_id'
       AND c.confdeltype <> 'n'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END
$fk$;

ALTER TABLE mailcaster.unsubscribes ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE mailcaster.blacklist    ALTER COLUMN user_id DROP NOT NULL;

DO $fk_add$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mailcaster.unsubscribes'::regclass
       AND contype = 'f'
       AND confrelid = 'mailcaster.profiles'::regclass
  ) THEN
    ALTER TABLE mailcaster.unsubscribes
      ADD CONSTRAINT unsubscribes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES mailcaster.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mailcaster.blacklist'::regclass
       AND contype = 'f'
       AND confrelid = 'mailcaster.profiles'::regclass
  ) THEN
    ALTER TABLE mailcaster.blacklist
      ADD CONSTRAINT blacklist_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES mailcaster.profiles(id) ON DELETE SET NULL;
  END IF;
END
$fk_add$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-b) unsubscribes.source + 수신자 발신 행 보호 RLS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE mailcaster.unsubscribes ADD COLUMN IF NOT EXISTS source TEXT;

DO $src_chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mailcaster.unsubscribes'::regclass
       AND conname = 'unsubscribes_source_check'
  ) THEN
    ALTER TABLE mailcaster.unsubscribes
      ADD CONSTRAINT unsubscribes_source_check
      CHECK (source IS NULL OR source IN ('manual', 'link', 'one_click', 'reply'));
  END IF;
END
$src_chk$;

-- 061 답장 자동 감지로 등록된 기존 행 (reason 고정 문구) → 'reply'
UPDATE mailcaster.unsubscribes
   SET source = 'reply'
 WHERE source IS NULL
   AND reason IN ('답장에서 수신거부 의사 자동 감지', '회신에서 수신거부 의사 자동 감지');

COMMENT ON COLUMN mailcaster.unsubscribes.source IS
  '등록 경로 — NULL/manual: 조직 멤버 수동, link/one_click: 수신거부 링크(079), reply: 회신 자동 감지. manual 외에는 admin 만 수정/삭제.';

-- 018 정책 교체 — 본인 등록분이라도 수신자 발신 행은 admin 만. UPDATE 도 막아야
-- source 를 'manual' 로 바꾼 뒤 지우는 우회가 불가능.
DROP POLICY IF EXISTS "unsubscribes_update_own_or_admin" ON mailcaster.unsubscribes;
CREATE POLICY "unsubscribes_update_own_or_admin" ON mailcaster.unsubscribes
  FOR UPDATE
  USING (
    (user_id = auth.uid() AND COALESCE(source, 'manual') = 'manual')
    OR mailcaster.user_is_org_admin(org_id)
  )
  WITH CHECK (
    (
      (user_id = auth.uid() AND COALESCE(source, 'manual') = 'manual')
      OR mailcaster.user_is_org_admin(org_id)
    )
    AND org_id IN (SELECT mailcaster.user_org_ids())
  );

DROP POLICY IF EXISTS "unsubscribes_delete_own_or_admin" ON mailcaster.unsubscribes;
CREATE POLICY "unsubscribes_delete_own_or_admin" ON mailcaster.unsubscribes
  FOR DELETE
  USING (
    (user_id = auth.uid() AND COALESCE(source, 'manual') = 'manual')
    OR mailcaster.user_is_org_admin(org_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) bulk_set_unsubscribed — unsubscribes 를 진실 원천으로
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

  IF p_unsubscribe THEN
    -- 조직 수신거부 목록 등록 → 019 트리거가 같은 email 의 모든 contacts 사본 동기화.
    -- UNIQUE(org_id, email) 는 원문 대소문자 기준이라 LOWER 중복은 NOT EXISTS 로 별도 차단.
    INSERT INTO mailcaster.unsubscribes (org_id, user_id, email, reason, source)
    SELECT DISTINCT p_org_id, v_uid, LOWER(TRIM(c.email)), '연락처 일괄 수신거부 (수동)', 'manual'
      FROM mailcaster.contacts c
     WHERE c.org_id = p_org_id
       AND c.id = ANY(p_contact_ids)
       AND NULLIF(TRIM(c.email), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM mailcaster.unsubscribes u
          WHERE u.org_id = p_org_id
            AND LOWER(u.email) = LOWER(TRIM(c.email))
       )
    ON CONFLICT (org_id, email) DO NOTHING;

    UPDATE mailcaster.contacts
       SET is_unsubscribed = TRUE,
           unsubscribed_at = COALESCE(unsubscribed_at, now())
     WHERE org_id = p_org_id
       AND id = ANY(p_contact_ids);
  ELSE
    -- 해제 — 호출자 본인이 수동 등록한 행만 삭제 (admin 포함). 수신자 발신(link/one_click/reply)
    -- 행은 절대 지우지 않음 — 수신자가 직접 거부한 주소를 발송자가 일괄 재구독시키지 못하게.
    -- 삭제 시 019 트리거가 같은 email 의 조직 contacts 플래그 해제.
    DELETE FROM mailcaster.unsubscribes u
     USING mailcaster.contacts c
     WHERE c.org_id = p_org_id
       AND c.id = ANY(p_contact_ids)
       AND u.org_id = p_org_id
       AND LOWER(u.email) = LOWER(TRIM(c.email))
       AND u.user_id = v_uid
       AND COALESCE(u.source, 'manual') = 'manual';

    -- 권한 밖 기록이 남은 email 은 플래그 유지 (발송 경로가 unsubscribes 로도 차단하므로 일관성 유지)
    UPDATE mailcaster.contacts c
       SET is_unsubscribed = FALSE,
           unsubscribed_at = NULL
     WHERE c.org_id = p_org_id
       AND c.id = ANY(p_contact_ids)
       AND NOT EXISTS (
         SELECT 1 FROM mailcaster.unsubscribes u
          WHERE u.org_id = p_org_id
            AND LOWER(u.email) = LOWER(TRIM(c.email))
       );
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.bulk_set_unsubscribed(UUID, UUID[], BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mailcaster.bulk_set_unsubscribed(UUID, UUID[], BOOLEAN)
  TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) record_thread_reply_optout — thread_messages 회신 기반 수신거부 (service_role 전용)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.record_thread_reply_optout(
  p_org_id             UUID,
  p_user_id            UUID,
  p_email              TEXT,
  p_source_campaign_id UUID DEFAULT NULL,
  p_reason             TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_email TEXT := LOWER(TRIM(COALESCE(p_email, '')));
  v_id    UUID;
BEGIN
  IF v_email = '' OR p_org_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mailcaster.organizations WHERE id = p_org_id) THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM mailcaster.unsubscribes
     WHERE org_id = p_org_id AND LOWER(email) = v_email
  ) THEN
    -- 이미 발송자가 수동 등록한 행이 있으면 수신자 본인 의사로 승격 — 그대로 두면 등록자가
    -- 'manual' 행을 지워 수신자의 수신거부를 되돌릴 수 있다 (1-b 보호 우회).
    UPDATE mailcaster.unsubscribes
       SET source = 'reply', user_id = NULL
     WHERE org_id = p_org_id AND LOWER(email) = v_email
       AND COALESCE(source, 'manual') = 'manual';
    UPDATE mailcaster.contacts
       SET is_unsubscribed = TRUE,
           unsubscribed_at = COALESCE(unsubscribed_at, now())
     WHERE org_id = p_org_id AND LOWER(email) = v_email
       AND COALESCE(is_unsubscribed, FALSE) = FALSE;
    RETURN FALSE;
  END IF;

  -- 수신자 발신 수신거부 — user_id NULL (발송자 소유가 아님 → admin 만 해제, 1-b).
  -- p_user_id 는 호출 호환용으로만 유지.
  INSERT INTO mailcaster.unsubscribes (org_id, user_id, email, reason, source_campaign_id, source)
  VALUES (
    p_org_id,
    NULL,
    v_email,
    COALESCE(p_reason, '회신에서 수신거부 의사 자동 감지'),
    p_source_campaign_id,
    'reply'
  )
  ON CONFLICT (org_id, email) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_thread_reply_optout(UUID, UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.record_thread_reply_optout(UUID, UUID, TEXT, UUID, TEXT)
  TO service_role;

COMMENT ON FUNCTION mailcaster.record_thread_reply_optout IS
  '1:1 스레드 회신에서 명시적 수신거부 감지 시 check-replies 가 호출 — unsubscribes 등록(트리거가 contacts 동기화).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) record_reply_optout (061) 재정의 — source='reply', user_id NULL. 시그니처/반환 동일.
--    user_id NOT NULL 이던 061 의 'org 대표 대체' 로직은 078 1) 로 불필요.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.record_reply_optout(
  p_email              TEXT,
  p_source_campaign_id UUID,
  p_reason             TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_email  TEXT := LOWER(TRIM(COALESCE(p_email, '')));
  v_org_id UUID;
  v_id     UUID;
BEGIN
  IF v_email = '' OR p_source_campaign_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT org_id INTO v_org_id
    FROM mailcaster.campaigns
   WHERE id = p_source_campaign_id;

  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- UNIQUE(org_id, email) 는 원문 대소문자 기준 — LOWER 중복은 선차단
  IF EXISTS (
    SELECT 1 FROM mailcaster.unsubscribes
     WHERE org_id = v_org_id AND LOWER(email) = v_email
  ) THEN
    -- 수동 등록 행 → 수신자 본인 의사로 승격 (record_thread_reply_optout 과 동일 이유)
    UPDATE mailcaster.unsubscribes
       SET source = 'reply', user_id = NULL
     WHERE org_id = v_org_id AND LOWER(email) = v_email
       AND COALESCE(source, 'manual') = 'manual';
    UPDATE mailcaster.contacts
       SET is_unsubscribed = TRUE,
           unsubscribed_at = COALESCE(unsubscribed_at, now())
     WHERE org_id = v_org_id AND LOWER(email) = v_email
       AND COALESCE(is_unsubscribed, FALSE) = FALSE;
    RETURN FALSE;
  END IF;

  INSERT INTO mailcaster.unsubscribes (org_id, user_id, email, reason, source_campaign_id, source)
  VALUES (
    v_org_id,
    NULL,
    v_email,
    COALESCE(p_reason, '답장에서 수신거부 의사 자동 감지'),
    p_source_campaign_id,
    'reply'
  )
  ON CONFLICT (org_id, email) DO NOTHING
  RETURNING id INTO v_id;
  -- INSERT 성공 시 trg_unsubscribes_sync_contacts 가 contacts.is_unsubscribed 동기화.

  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_reply_optout(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.record_reply_optout(TEXT, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION mailcaster.record_reply_optout IS
  '답장에서 명시적 수신거부 감지 시 check-replies 가 호출 — unsubscribes 등록(source=reply, user_id NULL; 트리거가 contacts 동기화).';
