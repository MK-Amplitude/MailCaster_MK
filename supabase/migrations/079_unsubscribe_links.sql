-- =============================================
-- 079 — 수신거부 링크 (정보통신망법 제50조 / RFC 8058 one-click)
-- ---------------------------------------------
-- 1) recipients.unsubscribe_token — 수신자별 추측 불가 토큰 (메일 footer 링크 +
--    List-Unsubscribe 헤더의 capability).
--    volatile DEFAULT(gen_random_uuid()) 를 ADD COLUMN 에 바로 주면 테이블 전체 rewrite +
--    ACCESS EXCLUSIVE 잠금이므로: nullable ADD → SET DEFAULT(이후 INSERT 부터 적용, rewrite 없음)
--    → 기존 행 단일 UPDATE 백필 → SET NOT NULL(검증 스캔만). DEFAULT 를 백필보다 먼저 걸어
--    백필과 NOT NULL 사이에 들어온 행이 NULL 로 남지 않게 한다.
--    UNIQUE 인덱스는 트랜잭션 안이라 CONCURRENTLY 불가 — recipients 가 큰 프로젝트는
--    진행 중인 캠페인이 없을 때 배포할 것.
-- 2) unsubscribe_by_token — Edge Function `unsubscribe`(verify_jwt=false, service_role) 전용.
--    토큰 → 수신자 → 캠페인(org_id) 역추적 후 unsubscribes 등록.
--    019 트리거가 조직 전체 contacts.is_unsubscribed 동기화 → 이후 발송 경로에서 차단.
--    record_reply_optout / record_thread_reply_optout(078) 과 같은 규칙:
--      · email LOWER 저장, LOWER 중복은 NOT EXISTS 로 선차단 + ON CONFLICT DO NOTHING
--      · 수신자 본인의 수신거부 → user_id NULL + source 'link' | 'one_click' (078 1-b).
--        발송자(캠페인 소유자)가 지울 수 없고 admin 만 해제 가능.
--      · 이미 수동(manual) 등록돼 있던 주소면 source 만 수신자 발신으로 승격 (이후 보호).
--    campaigns.unsubscribe_count 는 이번 호출로 새로 등록됐을 때만 +1 (링크 반복 클릭 안전).
--    anon/authenticated 는 호출 불가 (076 정책) — 공개 경로는 Edge Function 하나뿐.
--
-- 멱등: 몇 번 재실행해도 같은 결과.
-- =============================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) recipients.unsubscribe_token
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE mailcaster.recipients
  ADD COLUMN IF NOT EXISTS unsubscribe_token UUID;

ALTER TABLE mailcaster.recipients
  ALTER COLUMN unsubscribe_token SET DEFAULT gen_random_uuid();

UPDATE mailcaster.recipients
   SET unsubscribe_token = gen_random_uuid()
 WHERE unsubscribe_token IS NULL;

ALTER TABLE mailcaster.recipients
  ALTER COLUMN unsubscribe_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_unsubscribe_token
  ON mailcaster.recipients (unsubscribe_token);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) unsubscribe_by_token (service_role 전용)
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
BEGIN
  IF p_token IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE);
  END IF;

  SELECT r.campaign_id, LOWER(TRIM(COALESCE(r.email, '')))
    INTO v_campaign_id, v_email
    FROM mailcaster.recipients r
   WHERE r.unsubscribe_token = p_token;

  IF v_campaign_id IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('ok', FALSE);
  END IF;

  SELECT c.org_id
    INTO v_org_id
    FROM mailcaster.campaigns c
   WHERE c.id = v_campaign_id;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE);
  END IF;

  -- 확인 페이지 표시용 마스킹 (a***@domain) — 토큰 보유자에게 원문 주소를 돌려주지 않음
  v_at := POSITION('@' IN v_email);
  v_masked := CASE
    WHEN v_at > 1 THEN LEFT(v_email, 1) || '***' || SUBSTRING(v_email FROM v_at)
    ELSE '***'
  END;

  -- 이미 조직 수신거부 목록에 있으면 성공으로 응답 (재클릭/one-click 재시도).
  -- 수동 등록분이었다면 수신자 본인 의사로 승격 — 이후 발송자가 해제할 수 없게 (078 1-b).
  IF EXISTS (
    SELECT 1 FROM mailcaster.unsubscribes
     WHERE org_id = v_org_id AND LOWER(email) = v_email
  ) THEN
    UPDATE mailcaster.unsubscribes
       SET source = v_source
     WHERE org_id = v_org_id
       AND LOWER(email) = v_email
       AND COALESCE(source, 'manual') = 'manual';
    RETURN jsonb_build_object('ok', TRUE, 'email_masked', v_masked, 'already', TRUE);
  END IF;

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

  IF v_id IS NOT NULL THEN
    UPDATE mailcaster.campaigns
       SET unsubscribe_count = COALESCE(unsubscribe_count, 0) + 1
     WHERE id = v_campaign_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'email_masked', v_masked, 'already', v_id IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.unsubscribe_by_token(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mailcaster.unsubscribe_by_token(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION mailcaster.unsubscribe_by_token IS
  '메일 footer 수신거부 링크 / List-Unsubscribe one-click — Edge Function unsubscribe 가 호출 (service_role 전용). unsubscribes 등록(트리거가 contacts 동기화).';
