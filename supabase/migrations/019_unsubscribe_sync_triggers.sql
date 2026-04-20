-- =============================================
-- Phase 8 — 조직 전체 unsubscribe 동기화 트리거
-- ---------------------------------------------
-- 문제:
--   018 에서 unsubscribes 를 org 단위로 UNIQUE 하게 만들었지만,
--   contacts.is_unsubscribed 플래그는 여전히 "contact 소유자" 의 RLS 에 묶여
--   일반 멤버가 UPDATE 해도 다른 멤버의 contact 에는 반영되지 않는다.
--
--   결과적으로:
--     1) User A 가 foo@example.com 을 unsubscribe 추가해도 User B 의 같은
--        이메일 contact 은 is_unsubscribed=false 로 남음 → B 의 캠페인에서 발송됨.
--     2) 조직에 이미 등록된 unsubscribe email 을 새로 import/create 해도
--        is_unsubscribed=false 로 생성됨 → 발송됨.
--
-- 해결:
--   SECURITY DEFINER 트리거로 RLS 를 바이패스해 조직 전체에 자동 동기화.
--
--   1. sync_contacts_on_unsubscribe_change — unsubscribes INSERT/DELETE 시
--      같은 org 의 같은 email 의 모든 contacts 플래그 일괄 설정/해제.
--
--   2. apply_unsubscribe_to_new_contact — contacts BEFORE INSERT 시
--      같은 org 에 이미 unsubscribe 등록된 email 이면 플래그 자동 true.
--
-- 보조 효과:
--   useUnsubscribes.ts 의 명시적 contacts UPDATE 로직은 이제 불필요
--   (트리거가 대신) — 프런트는 unsubscribes 에만 쓰면 끝.
--   엣지 함수(recipient unsubscribe) 도 같은 방식으로 안전.
-- =============================================

-- =============================================
-- 1. unsubscribes INSERT/DELETE → contacts 동기화
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.sync_contacts_on_unsubscribe_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 같은 org 의 같은 email contacts 전부 is_unsubscribed=true 로 설정
    -- email 대소문자 비대칭 방어 — unsubscribes 는 lowercase 로 저장되지만
    -- contacts 는 수동 생성 시 대소문자 원본 유지될 수 있음.
    UPDATE mailcaster.contacts
       SET is_unsubscribed = TRUE,
           unsubscribed_at = COALESCE(NEW.unsubscribed_at, NOW())
     WHERE org_id = NEW.org_id
       AND LOWER(email) = LOWER(NEW.email)
       AND (is_unsubscribed = FALSE OR unsubscribed_at IS NULL);
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- unsubscribe 해제 시 같은 org 의 같은 email contacts 플래그 해제
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

COMMENT ON FUNCTION mailcaster.sync_contacts_on_unsubscribe_change() IS
  'unsubscribes INSERT/DELETE 시 같은 org 의 모든 contacts.is_unsubscribed 를 동기화.
   RLS 바이패스를 위해 SECURITY DEFINER. 일반 멤버가 등록한 unsubscribe 도 조직 전체에 반영됨.';

DROP TRIGGER IF EXISTS trg_unsubscribes_sync_contacts ON mailcaster.unsubscribes;
CREATE TRIGGER trg_unsubscribes_sync_contacts
  AFTER INSERT OR DELETE ON mailcaster.unsubscribes
  FOR EACH ROW
  EXECUTE FUNCTION mailcaster.sync_contacts_on_unsubscribe_change();

-- =============================================
-- 2. contacts BEFORE INSERT → 기존 unsubscribe 자동 반영
-- ---------------------------------------------
-- 새 contact 이 생성될 때 같은 (org_id, email) 이 이미 unsubscribes 에 있으면
-- 플래그를 미리 true 로 설정. BEFORE INSERT 이므로 NEW 수정 가능.
-- =============================================
CREATE OR REPLACE FUNCTION mailcaster.apply_unsubscribe_to_new_contact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, public
AS $$
DECLARE
  v_unsubscribed_at TIMESTAMPTZ;
BEGIN
  -- email 이 없으면 skip (그런 row 는 NOT NULL 제약에 의해 어차피 실패할 것이지만 방어)
  IF NEW.email IS NULL OR NEW.email = '' THEN
    RETURN NEW;
  END IF;

  -- 같은 org 에 이미 unsubscribe 등록되어 있나?
  SELECT unsubscribed_at INTO v_unsubscribed_at
    FROM mailcaster.unsubscribes
   WHERE org_id = NEW.org_id
     AND LOWER(email) = LOWER(NEW.email)
   LIMIT 1;

  IF v_unsubscribed_at IS NOT NULL THEN
    NEW.is_unsubscribed := TRUE;
    -- 이미 명시적으로 설정돼 있지 않으면 unsubscribes 의 시각을 물려받음
    IF NEW.unsubscribed_at IS NULL THEN
      NEW.unsubscribed_at := v_unsubscribed_at;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION mailcaster.apply_unsubscribe_to_new_contact() IS
  '새 contact 생성 시 같은 org 에 unsubscribe 가 등록된 email 이면 is_unsubscribed 를 자동으로 true 로 설정.
   조직 공유 차단을 import/수동 생성 시점에도 보장.';

DROP TRIGGER IF EXISTS trg_contacts_apply_unsubscribe ON mailcaster.contacts;
CREATE TRIGGER trg_contacts_apply_unsubscribe
  BEFORE INSERT ON mailcaster.contacts
  FOR EACH ROW
  EXECUTE FUNCTION mailcaster.apply_unsubscribe_to_new_contact();

-- =============================================
-- 3. 기존 데이터 일괄 정정 (one-shot)
-- ---------------------------------------------
-- 018 을 적용하기 전에 각 유저가 자기 것만 동기화해 둔 상태에서,
-- 트리거 도입 후 기존 불일치(A 가 등록한 unsubscribe 가 B 의 contact 에 반영 안 된 케이스)
-- 도 소급 적용한다.
-- =============================================
UPDATE mailcaster.contacts c
   SET is_unsubscribed = TRUE,
       unsubscribed_at = COALESCE(c.unsubscribed_at, u.unsubscribed_at)
  FROM mailcaster.unsubscribes u
 WHERE c.org_id = u.org_id
   AND LOWER(c.email) = LOWER(u.email)
   AND c.is_unsubscribed = FALSE;
