-- =============================================
-- 고도화 QW1 — 회신 인텐트 라우팅: 명시적 수신거부 자동 처리
-- ---------------------------------------------
-- check-replies 가 답장을 분류할 때, "명시적 수신거부 의사"(그만 보내주세요/수신거부/
-- unsubscribe/remove me)를 6번째 카테고리 'unsubscribe' 로 감지하면 자동으로
-- unsubscribes 에 등록한다. (트리거 019 가 contacts.is_unsubscribed 동기화 → 발송 스킵)
--
-- 안전성: 키워드가 아닌 LLM 의도 분류로만 작동(오탐 최소화). not_interested 같은
-- 미온적 거절은 자동 suppress 하지 않음 — 명시적 opt-out 요청에만 한정.
-- =============================================

-- 1) recipients.reply_category 에 'unsubscribe' 허용 (028 제약 갱신)
ALTER TABLE mailcaster.recipients
  DROP CONSTRAINT IF EXISTS recipients_reply_category_check;

ALTER TABLE mailcaster.recipients
  ADD CONSTRAINT recipients_reply_category_check
  CHECK (
    reply_category IS NULL
    OR reply_category IN (
      'interested',
      'not_interested',
      'question',
      'out_of_office',
      'unclear',
      'unsubscribe'
    )
  );

-- 2) 답장 기반 수신거부 등록 RPC (service_role 전용 — check-replies 호출)
-- email + source campaign 만 받아 org_id/user_id 는 캠페인에서 역추적.
-- unsubscribes 의 UNIQUE(org_id, email) + ON CONFLICT DO NOTHING 로 중복 안전.
CREATE OR REPLACE FUNCTION mailcaster.record_reply_optout(
  p_email              TEXT,
  p_source_campaign_id UUID,
  p_reason             TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mailcaster, pg_catalog, public
AS $$
DECLARE
  v_email   TEXT := LOWER(TRIM(COALESCE(p_email, '')));
  v_org_id  UUID;
  v_user_id UUID;
  v_id      UUID;
BEGIN
  IF v_email = '' OR p_source_campaign_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT org_id, user_id
    INTO v_org_id, v_user_id
    FROM mailcaster.campaigns
   WHERE id = p_source_campaign_id;

  IF v_org_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- unsubscribes.user_id 는 NOT NULL (등록자 추적용) — 캠페인 소유자, 없으면 org 대표.
  IF v_user_id IS NULL THEN
    SELECT user_id INTO v_user_id
      FROM mailcaster.org_members
     WHERE org_id = v_org_id
     ORDER BY joined_at ASC
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  INSERT INTO mailcaster.unsubscribes (org_id, user_id, email, reason, source_campaign_id)
  VALUES (
    v_org_id,
    v_user_id,
    v_email,
    COALESCE(p_reason, '답장에서 수신거부 의사 자동 감지'),
    p_source_campaign_id
  )
  ON CONFLICT (org_id, email) DO NOTHING
  RETURNING id INTO v_id;
  -- INSERT 성공 시 trg_unsubscribes_sync_contacts 가 contacts.is_unsubscribed 동기화.

  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION mailcaster.record_reply_optout(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mailcaster.record_reply_optout(TEXT, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION mailcaster.record_reply_optout IS
  '답장에서 명시적 수신거부 감지 시 check-replies 가 호출 — unsubscribes 등록(트리거가 contacts 동기화).';
