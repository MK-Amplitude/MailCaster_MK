-- =============================================
-- 080 — 수신거부 보강 (079 후속 / 정보통신망법 제50조)
-- ---------------------------------------------
-- 1) unsubscribe_tokens — 토큰 → (org_id, email) 영구 매핑
--    recipients 는 campaigns ON DELETE CASCADE 라서 발송 후 캠페인을 삭제하면
--    recipients.unsubscribe_token 도 함께 사라져, 이미 발송된 메일의 footer 링크 /
--    List-Unsubscribe one-click 이 "완료" 응답만 하고 아무것도 기록하지 않았다.
--    → 캠페인 삭제와 무관한 별도 테이블에 매핑을 보존 (campaign_id 는 ON DELETE SET NULL).
--      · RLS ENABLE + 정책 없음 = service_role 전용 (클라이언트는 읽기/쓰기 불가)
--      · recipients AFTER INSERT (statement 단위, transition table) 트리거가 채움
--      · 기존 recipients 일회성 백필 (ON CONFLICT DO NOTHING — 재실행 안전)
--      · org 삭제 시 매핑도 삭제 (unsubscribes 도 org CASCADE 이므로 같은 수명)
--
-- 2) unsubscribe_by_token 재정의 (시그니처/반환 079 와 동일 — Edge Function 호환)
--      · unsubscribe_tokens 우선 조회, 없으면 recipients→campaigns 로 폴백 (트리거 누락 방어)
--      · 이미 등록된 주소(already) 분기에서도 contacts.is_unsubscribed 를 TRUE 로 재동기화
--        (발송자가 contacts 플래그만 FALSE 로 돌려놓은 상태를 링크 재클릭으로 복구)
--      · 수동(manual) 행 승격 시 user_id NULL — 수신자 발신 행 규칙(078 1-b)과 통일
--    unsubscribe_token_info(p_token) — SPA 확인 페이지 미리보기용 (부작용 없음).
--      {found, email_masked, already}. CC/BCC 수신자가 남의 링크를 누르기 전에
--      대상 주소(마스킹)를 확인할 수 있게 한다.
--
-- 3) campaigns.last_error — 서버 발송 워커가 치명적 중단 / 할당량 재예약 / poison-pill
--    실패 사유(짧은 한국어)를 기록. 정상 완료·사용자 재예약 시 NULL 로 정리.
--
-- 4) 수신자 본인 수신거부(source link/one_click/reply) 무결성
--      · contacts BEFORE UPDATE 트리거 — 보호 행이 있는 주소의 is_unsubscribed TRUE→FALSE
--        를 예외로 거부 ('수신자가 직접 수신거부한 연락처는 해제할 수 없습니다').
--        RLS 상 unsubscribes 삭제는 막혀도 contacts 직접 UPDATE(PostgREST PATCH /
--        useToggleUnsubscribe 폴백)로 플래그를 끄면 process-sequences 가 다시 발송했다.
--        admin 이 수신거부 관리 화면에서 보호 행을 삭제하는 정상 경로는 019 AFTER DELETE
--        트리거가 행 삭제 *후* 플래그를 해제하므로 그대로 동작. service_role 우회 없음.
--      · email/org 변경으로 수신거부 주소가 된 contact 는 플래그 자동 TRUE
--        (019 BEFORE INSERT 와 같은 규칙 — 주소 바꿔 끄고 되돌리는 우회 차단)
--      · 019 sync_contacts_on_unsubscribe_change DELETE 분기 — 같은 주소의 다른
--        unsubscribes 행(대소문자만 다른 중복)이 남아 있으면 플래그를 해제하지 않음
--        (보호 행이 남은 상태에서 수동 중복 행 삭제가 위 트리거 예외로 실패하지 않게)
--      · 078 백필로 source='reply' 가 된 기존 행(user_id = 캠페인 소유자)도 user_id NULL —
--        발송자 UI 에 동작하지 않는 삭제 버튼이 보이던 문제 정리.
--
-- 모든 함수: SECURITY DEFINER + SET search_path = mailcaster, public,
--            anon/authenticated EXECUTE 회수, service_role 만 (076 정책).
-- 078 → 079 → 080 이 한 번의 db push 로 순서대로 적용돼도 안전. 멱등.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) unsubscribe_tokens
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mailcaster.unsubscribe_tokens (
  token       UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES mailcaster.organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  campaign_id UUID NULL REFERENCES mailcaster.campaigns(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- campaigns 삭제 시 SET NULL 대상 탐색용
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_campaign_id
  ON mailcaster.unsubscribe_tokens (campaign_id);

ALTER TABLE mailcaster.unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- 정책 없음 — service_role(RLS 우회)과 SECURITY DEFINER 함수만 접근.
REVOKE ALL ON TABLE mailcaster.unsubscribe_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE mailcaster.unsubscribe_tokens TO service_role;

COMMENT ON TABLE mailcaster.unsubscribe_tokens IS
  '수신거부 토큰 → (org_id, email) 영구 매핑. 캠페인/수신자 삭제 후에도 발송된 메일의 수신거부 링크가 동작하도록 보존. service_role 전용(RLS 정책 없음).';

-- recipients INSERT → 매핑 기록 (statement 단위 — 위저드의 대량 INSERT 에서 행마다 조회하지 않음)
CREATE OR REPLACE FUNCTION mailcaster.record_unsubscribe_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
BEGIN
  INSERT INTO mailcaster.unsubscribe_tokens (token, org_id, email, campaign_id)
  SELECT n.unsubscribe_token, c.org_id, LOWER(TRIM(n.email)), n.campaign_id
    FROM new_recipients n
    JOIN mailcaster.campaigns c ON c.id = n.campaign_id
   WHERE n.unsubscribe_token IS NOT NULL
     AND c.org_id IS NOT NULL
     AND NULLIF(TRIM(n.email), '') IS NOT NULL
  -- 기존 매핑 유지 (같은 토큰이 다시 들어와도 이미 발송된 링크의 대상이 바뀌지 않게)
  ON CONFLICT (token) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_unsubscribe_tokens() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.record_unsubscribe_tokens() TO service_role;

DROP TRIGGER IF EXISTS trg_recipients_record_unsubscribe_tokens ON mailcaster.recipients;
CREATE TRIGGER trg_recipients_record_unsubscribe_tokens
  AFTER INSERT ON mailcaster.recipients
  REFERENCING NEW TABLE AS new_recipients
  FOR EACH STATEMENT
  EXECUTE FUNCTION mailcaster.record_unsubscribe_tokens();

-- 기존 recipients 백필 (트리거 생성 후 — 그 사이 INSERT 는 트리거가, 겹치면 ON CONFLICT)
INSERT INTO mailcaster.unsubscribe_tokens (token, org_id, email, campaign_id, created_at)
SELECT r.unsubscribe_token, c.org_id, LOWER(TRIM(r.email)), r.campaign_id, COALESCE(r.created_at, now())
  FROM mailcaster.recipients r
  JOIN mailcaster.campaigns c ON c.id = r.campaign_id
 WHERE r.unsubscribe_token IS NOT NULL
   AND c.org_id IS NOT NULL
   AND NULLIF(TRIM(r.email), '') IS NOT NULL
ON CONFLICT (token) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2-a) unsubscribe_by_token 재정의 (service_role 전용) — 시그니처 (UUID, TEXT) → JSONB 유지
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.unsubscribe_by_token(
  p_token  UUID,
  p_source TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_campaign_id UUID;
  v_email       TEXT;
  v_org_id      UUID;
  v_source      TEXT := CASE WHEN p_source = 'one_click' THEN 'one_click' ELSE 'link' END;
  v_id          UUID;
  v_at          INT;
  v_masked      TEXT;
  v_already     BOOLEAN;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE);
  END IF;

  -- 영구 매핑 우선 (캠페인 삭제 후에도 유효)
  SELECT t.org_id, t.email, t.campaign_id
    INTO v_org_id, v_email, v_campaign_id
    FROM mailcaster.unsubscribe_tokens t
   WHERE t.token = p_token;

  -- 폴백 — 매핑 누락(트리거 비활성 등) 대비
  IF v_org_id IS NULL THEN
    SELECT c.org_id, r.email, r.campaign_id
      INTO v_org_id, v_email, v_campaign_id
      FROM mailcaster.recipients r
      JOIN mailcaster.campaigns c ON c.id = r.campaign_id
     WHERE r.unsubscribe_token = p_token;
  END IF;

  v_email := LOWER(TRIM(COALESCE(v_email, '')));
  IF v_org_id IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('ok', FALSE);
  END IF;

  -- 확인 페이지 표시용 마스킹 (a***@domain) — 토큰 보유자에게 원문 주소를 돌려주지 않음
  v_at := POSITION('@' IN v_email);
  v_masked := CASE
    WHEN v_at > 1 THEN LEFT(v_email, 1) || '***' || SUBSTRING(v_email FROM v_at)
    ELSE '***'
  END;

  IF EXISTS (
    SELECT 1 FROM mailcaster.unsubscribes
     WHERE org_id = v_org_id AND LOWER(email) = v_email
  ) THEN
    -- 재클릭 / one-click 재시도. 수동 등록분이었다면 수신자 본인 의사로 승격 —
    -- 이후 발송자가 해제할 수 없게 (078 1-b: 수신자 발신 행은 user_id NULL).
    UPDATE mailcaster.unsubscribes
       SET source  = v_source,
           user_id = NULL
     WHERE org_id = v_org_id
       AND LOWER(email) = v_email
       AND COALESCE(source, 'manual') = 'manual';
    v_already := TRUE;
  ELSE
    -- 수신자 발신 — user_id NULL (발송자 소유 아님), source 로 경로 표시
    INSERT INTO mailcaster.unsubscribes (org_id, user_id, email, reason, source_campaign_id, source)
    VALUES (
      v_org_id,
      NULL,
      v_email,
      CASE
        WHEN v_source = 'one_click' THEN '수신거부 링크 (메일 클라이언트 원클릭)'
        ELSE '수신거부 링크'
      END,
      v_campaign_id,
      v_source
    )
    ON CONFLICT (org_id, email) DO NOTHING
    RETURNING id INTO v_id;
    -- INSERT 성공 시 trg_unsubscribes_sync_contacts 가 contacts.is_unsubscribed 동기화.
    v_already := v_id IS NULL;

    IF v_id IS NOT NULL AND v_campaign_id IS NOT NULL THEN
      UPDATE mailcaster.campaigns
         SET unsubscribe_count = COALESCE(unsubscribe_count, 0) + 1
       WHERE id = v_campaign_id;
    END IF;
  END IF;

  -- contacts 재동기화 — already 분기(INSERT 없음 → 019 트리거 미발동)에서도
  -- 발송자가 플래그만 꺼 둔 사본을 다시 차단. 이미 맞으면 0행.
  UPDATE mailcaster.contacts
     SET is_unsubscribed = TRUE,
         unsubscribed_at = COALESCE(unsubscribed_at, now())
   WHERE org_id = v_org_id
     AND LOWER(email) = v_email
     AND (is_unsubscribed IS DISTINCT FROM TRUE OR unsubscribed_at IS NULL);

  RETURN jsonb_build_object('ok', TRUE, 'email_masked', v_masked, 'already', v_already);
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.unsubscribe_by_token(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.unsubscribe_by_token(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION mailcaster.unsubscribe_by_token IS
  '메일 footer 수신거부 링크 / List-Unsubscribe one-click — Edge Function unsubscribe 가 호출 (service_role 전용). unsubscribe_tokens(080) 로 토큰 해석 → unsubscribes 등록 + contacts 재동기화. 반환 {ok, email_masked, already}.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2-b) unsubscribe_token_info — 미리보기 (service_role 전용, 부작용 없음)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.unsubscribe_token_info(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_email  TEXT;
  v_org_id UUID;
  v_at     INT;
  v_masked TEXT;
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('found', FALSE);
  END IF;

  SELECT t.org_id, t.email
    INTO v_org_id, v_email
    FROM mailcaster.unsubscribe_tokens t
   WHERE t.token = p_token;

  IF v_org_id IS NULL THEN
    SELECT c.org_id, r.email
      INTO v_org_id, v_email
      FROM mailcaster.recipients r
      JOIN mailcaster.campaigns c ON c.id = r.campaign_id
     WHERE r.unsubscribe_token = p_token;
  END IF;

  v_email := LOWER(TRIM(COALESCE(v_email, '')));
  IF v_org_id IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('found', FALSE);
  END IF;

  v_at := POSITION('@' IN v_email);
  v_masked := CASE
    WHEN v_at > 1 THEN LEFT(v_email, 1) || '***' || SUBSTRING(v_email FROM v_at)
    ELSE '***'
  END;

  RETURN jsonb_build_object(
    'found', TRUE,
    'email_masked', v_masked,
    'already', EXISTS (
      SELECT 1 FROM mailcaster.unsubscribes
       WHERE org_id = v_org_id AND LOWER(email) = v_email
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.unsubscribe_token_info(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.unsubscribe_token_info(UUID) TO service_role;

COMMENT ON FUNCTION mailcaster.unsubscribe_token_info IS
  '수신거부 확인 페이지 미리보기 — Edge Function unsubscribe(preview) 가 호출 (service_role 전용, 읽기 전용). 반환 {found, email_masked, already}.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) campaigns.last_error
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE mailcaster.campaigns ADD COLUMN IF NOT EXISTS last_error TEXT NULL;

COMMENT ON COLUMN mailcaster.campaigns.last_error IS
  '서버 발송 중단/재예약/실패 사유(짧은 한국어). 정상 완료 또는 사용자가 다시 발송 예약하면 NULL.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-a) 019 DELETE 분기 보강 — 같은 주소의 다른 unsubscribes 행이 남아 있으면 플래그 유지
--      (INSERT 분기 / 트리거 정의는 019 그대로)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.sync_contacts_on_unsubscribe_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 같은 org 의 같은 email contacts 전부 is_unsubscribed=true 로 설정
    -- (unsubscribes 는 lowercase 저장, contacts 는 원문 대소문자일 수 있음)
    UPDATE mailcaster.contacts
       SET is_unsubscribed = TRUE,
           unsubscribed_at = COALESCE(NEW.unsubscribed_at, NOW())
     WHERE org_id = NEW.org_id
       AND LOWER(email) = LOWER(NEW.email)
       AND (is_unsubscribed = FALSE OR unsubscribed_at IS NULL);
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- unsubscribe 해제 시 같은 org 의 같은 email contacts 플래그 해제 —
    -- 단 대소문자만 다른 중복 행이 남아 있으면 여전히 수신거부 상태이므로 유지 (080).
    -- AFTER 트리거라 삭제된 행 자체는 여기서 보이지 않음.
    IF EXISTS (
      SELECT 1 FROM mailcaster.unsubscribes u
       WHERE u.org_id = OLD.org_id
         AND LOWER(u.email) = LOWER(OLD.email)
    ) THEN
      RETURN OLD;
    END IF;

    UPDATE mailcaster.contacts
       SET is_unsubscribed = FALSE,
           unsubscribed_at = NULL
     WHERE org_id = OLD.org_id
       AND LOWER(email) = LOWER(OLD.email)
       AND is_unsubscribed = TRUE;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.sync_contacts_on_unsubscribe_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.sync_contacts_on_unsubscribe_change() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-b) contacts BEFORE UPDATE — 수신자 본인 수신거부 보호
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mailcaster.protect_recipient_optout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_unsubscribed_at TIMESTAMPTZ;
BEGIN
  -- (1) 플래그 해제(TRUE→FALSE) — 수신자 본인이 거부한 주소면 거부.
  --     기존/새 주소·조직 모두 확인 (주소·조직을 함께 바꾸며 끄는 우회 차단).
  IF COALESCE(OLD.is_unsubscribed, FALSE) AND NOT COALESCE(NEW.is_unsubscribed, FALSE) THEN
    IF EXISTS (
      SELECT 1 FROM mailcaster.unsubscribes u
       WHERE u.org_id IN (OLD.org_id, NEW.org_id)
         AND LOWER(u.email) IN (LOWER(TRIM(OLD.email)), LOWER(TRIM(NEW.email)))
         AND u.source IN ('link', 'one_click', 'reply')
    ) THEN
      RAISE EXCEPTION '수신자가 직접 수신거부한 연락처는 해제할 수 없습니다'
        USING ERRCODE = '42501',
              HINT = '수신자가 수신거부 링크·회신으로 직접 거부한 주소입니다. 조직 관리자가 수신거부 관리 화면에서만 해제할 수 있습니다.';
    END IF;
  END IF;

  -- (2) 주소/조직 변경으로 조직 수신거부 목록에 있는 주소가 되면 플래그 TRUE
  --     (019 BEFORE INSERT 와 같은 규칙 — 주소를 바꿔 끈 뒤 되돌리는 우회 차단)
  IF NOT COALESCE(NEW.is_unsubscribed, FALSE)
     AND (LOWER(TRIM(NEW.email)), NEW.org_id) IS DISTINCT FROM (LOWER(TRIM(OLD.email)), OLD.org_id)
  THEN
    SELECT u.unsubscribed_at INTO v_unsubscribed_at
      FROM mailcaster.unsubscribes u
     WHERE u.org_id = NEW.org_id
       AND LOWER(u.email) = LOWER(TRIM(NEW.email))
     LIMIT 1;
    IF FOUND THEN
      NEW.is_unsubscribed := TRUE;
      NEW.unsubscribed_at := COALESCE(NEW.unsubscribed_at, v_unsubscribed_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.protect_recipient_optout() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.protect_recipient_optout() TO service_role;

COMMENT ON FUNCTION mailcaster.protect_recipient_optout() IS
  'contacts BEFORE UPDATE — 수신자 본인 수신거부(source link/one_click/reply)가 있는 주소의 is_unsubscribed 해제 거부, 주소/조직 변경 시 수신거부 목록 반영.';

DROP TRIGGER IF EXISTS trg_contacts_protect_optout ON mailcaster.contacts;
CREATE TRIGGER trg_contacts_protect_optout
  BEFORE UPDATE OF is_unsubscribed, email, org_id ON mailcaster.contacts
  FOR EACH ROW
  WHEN (NOT COALESCE(NEW.is_unsubscribed, FALSE))
  EXECUTE FUNCTION mailcaster.protect_recipient_optout();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-c) 수신자 발신 행 user_id 정리 — 078 이 reason 으로 'reply' 백필한 기존 행은
--      user_id = 캠페인 소유자로 남아 발송자 UI 에 (RLS 로 막힌) 삭제 버튼이 보였다.
--      UPDATE 이므로 019 트리거(INSERT/DELETE) 미발동.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE mailcaster.unsubscribes
   SET user_id = NULL
 WHERE source IN ('link', 'one_click', 'reply')
   AND user_id IS NOT NULL;
